// =============================================================================
// AI Cutter — Web
// Reimplementação, no navegador, do motor de detecção do app desktop:
//   - Detector 1: pico de áudio (RMS acima da média + N desvios-padrão)
//   - Detector 2: cena agitada (diferença entre frames acima de um limiar)
//   - Combinação: cooldown geral + janela de combinação -> tag "viral"
// Tudo roda 100% local (Web Audio API + <canvas>), nada é enviado a servidor.
// =============================================================================

const els = {
  dropzone: document.getElementById("dropzone"),
  inputArquivo: document.getElementById("inputArquivo"),
  preview: document.getElementById("preview"),
  videoPreview: document.getElementById("videoPreview"),
  previewNome: document.getElementById("previewNome"),
  previewMeta: document.getElementById("previewMeta"),
  btnTrocarVideo: document.getElementById("btnTrocarVideo"),

  painelConfig: document.getElementById("painelConfig"),
  painelStatus: document.getElementById("painelStatus"),
  painelResultados: document.getElementById("painelResultados"),
  painelVazio: document.getElementById("painelVazio"),

  btnAnalisar: document.getElementById("btnAnalisar"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
  log: document.getElementById("log"),

  resultsGrid: document.getElementById("resultsGrid"),
  resultsCount: document.getElementById("resultsCount"),

  canvasOculto: document.getElementById("canvasOculto"),
  videoOculto: document.getElementById("videoOculto"),
  waveform: document.getElementById("waveform"),
};

// Sliders <-> valores exibidos
const sliders = [
  ["cfgSensibilidade", "valSensibilidade", (v) => `${v}×`],
  ["cfgLimiarCena", "valLimiarCena", (v) => `${v}`],
  ["cfgCortesCena", "valCortesCena", (v) => `${v}`],
  ["cfgDuracao", "valDuracao", (v) => `${v}s`],
  ["cfgCooldown", "valCooldown", (v) => `${v}s`],
  ["cfgCombinacao", "valCombinacao", (v) => `${v}s`],
];
sliders.forEach(([inputId, outId, fmt]) => {
  const input = document.getElementById(inputId);
  const out = document.getElementById(outId);
  const update = () => (out.textContent = fmt(input.value));
  input.addEventListener("input", update);
  update();
});

function lerConfig() {
  return {
    sensibilidadeAudio: parseFloat(document.getElementById("cfgSensibilidade").value),
    limiarCena: parseFloat(document.getElementById("cfgLimiarCena").value),
    cortesMinCena: parseInt(document.getElementById("cfgCortesCena").value, 10),
    duracaoCorte: parseInt(document.getElementById("cfgDuracao").value, 10),
    cooldownGeral: parseInt(document.getElementById("cfgCooldown").value, 10),
    janelaCombinacao: parseInt(document.getElementById("cfgCombinacao").value, 10),
    // parâmetros fixos, espelhando o motor original (main.py)
    janelaAudio: 4,
    passoAudio: 3,
    aquecimento: 10, // aquecimento reduzido: aqui já temos o vídeo inteiro, não uma live
    tamanhoBaseline: 40,
    limiarMinimoAudio: 0.015, // piso absoluto (escala 0..1 do Web Audio)
    passoCena: 1, // segundos entre amostras de frame
    janelaCena: 5,
    intervaloCena: 6,
  };
}

let state = {
  file: null,
  videoURL: null,
  duration: 0,
};

// ---------------------------------------------------------------------------
// Log de status (mesma linguagem do app: emojis + motivo do corte)
// ---------------------------------------------------------------------------
function log(msg) {
  const linha = document.createElement("div");
  linha.className = "log-line";
  linha.innerHTML = msg;
  els.log.appendChild(linha);
  els.log.scrollTop = els.log.scrollHeight;
}
function setProgresso(pct, label) {
  els.progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (label) els.progressLabel.textContent = label;
}

// ---------------------------------------------------------------------------
// Upload / dropzone
// ---------------------------------------------------------------------------
els.dropzone.addEventListener("click", () => els.inputArquivo.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") els.inputArquivo.click();
});
["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) carregarArquivo(f);
});
els.inputArquivo.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) carregarArquivo(f);
});
els.btnTrocarVideo.addEventListener("click", () => {
  els.preview.hidden = true;
  els.dropzone.hidden = false;
  els.painelConfig.hidden = true;
  els.painelStatus.hidden = true;
  els.painelResultados.hidden = true;
  els.painelVazio.hidden = true;
  els.inputArquivo.value = "";
});

function carregarArquivo(file) {
  if (!file.type.startsWith("video/")) {
    alert("Escolhe um arquivo de vídeo (mp4, webm, mov...).");
    return;
  }
  state.file = file;
  state.videoURL = URL.createObjectURL(file);

  els.videoPreview.src = state.videoURL;
  els.videoOculto.src = state.videoURL;

  els.previewNome.textContent = file.name;
  els.previewMeta.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  els.dropzone.hidden = true;
  els.preview.hidden = false;
  els.painelConfig.hidden = false;
  els.painelStatus.hidden = true;
  els.painelResultados.hidden = true;
  els.painelVazio.hidden = true;

  els.videoPreview.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = els.videoPreview.duration;
      els.previewMeta.textContent += ` · ${formatarTempo(state.duration)}`;
    },
    { once: true }
  );
}

// ---------------------------------------------------------------------------
// Detector 1: pico de áudio (RMS + baseline móvel)
// ---------------------------------------------------------------------------
async function detectarPicosAudio(file, cfg, onProgresso) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const sampleRate = audioBuffer.sampleRate;
  const canais = audioBuffer.numberOfChannels;
  // mixa pra mono
  let dados = audioBuffer.getChannelData(0);
  if (canais > 1) {
    const mix = new Float32Array(dados.length);
    for (let c = 0; c < canais; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mix[i] += ch[i] / canais;
    }
    dados = mix;
  }

  const duracao = audioBuffer.duration;
  const tamJanela = Math.floor(cfg.janelaAudio * sampleRate);
  const passoAmostras = Math.floor(cfg.passoAudio * sampleRate);

  const baseline = [];
  const sinais = [];
  const curvaRms = []; // pra desenhar no hero

  let pos = 0;
  while (pos + tamJanela <= dados.length) {
    const tempoJanela = pos / sampleRate;
    let somaQuadrados = 0;
    for (let i = pos; i < pos + tamJanela; i++) somaQuadrados += dados[i] * dados[i];
    const rms = Math.sqrt(somaQuadrados / tamJanela);
    curvaRms.push({ t: tempoJanela + cfg.janelaAudio, rms });

    if (tempoJanela >= cfg.aquecimento) {
      if (baseline.length >= 5) {
        const media = baseline.reduce((a, b) => a + b, 0) / baseline.length;
        const variancia = baseline.reduce((a, b) => a + (b - media) ** 2, 0) / baseline.length;
        const desvio = Math.sqrt(variancia) || 0.0001;
        const limiar = Math.max(media + cfg.sensibilidadeAudio * desvio, cfg.limiarMinimoAudio);
        if (rms > limiar) {
          sinais.push({ time: tempoJanela + cfg.janelaAudio, motivo: "audio_pico" });
        }
      }
      baseline.push(rms);
      if (baseline.length > cfg.tamanhoBaseline) baseline.shift();
    }
    pos += passoAmostras;
    if (pos % (passoAmostras * 8) === 0 && onProgresso) {
      onProgresso(tempoJanela / duracao);
      await frame();
    }
  }

  audioCtx.close();
  return { sinais, curvaRms, duracao };
}

// ---------------------------------------------------------------------------
// Detector 2: cena agitada (diferença de frame por amostragem)
// ---------------------------------------------------------------------------
async function detectarCortesCena(videoEl, duracao, cfg, onProgresso) {
  const cv = els.canvasOculto;
  const LARGURA = 48, ALTURA = 27;
  cv.width = LARGURA;
  cv.height = ALTURA;
  const ctx = cv.getContext("2d", { willReadFrequently: true });

  const eventosDiff = []; // {t, diff}
  let anterior = null;

  for (let t = 0; t < duracao; t += cfg.passoCena) {
    await seekPara(videoEl, t);
    ctx.drawImage(videoEl, 0, 0, LARGURA, ALTURA);
    const frame = ctx.getImageData(0, 0, LARGURA, ALTURA).data;

    if (anterior) {
      let somaDiff = 0;
      for (let i = 0; i < frame.length; i += 4) {
        const l1 = 0.299 * anterior[i] + 0.587 * anterior[i + 1] + 0.114 * anterior[i + 2];
        const l2 = 0.299 * frame[i] + 0.587 * frame[i + 1] + 0.114 * frame[i + 2];
        somaDiff += Math.abs(l1 - l2);
      }
      const diffNormalizado = somaDiff / ((frame.length / 4) * 255);
      eventosDiff.push({ t, diff: diffNormalizado });
    }
    anterior = frame;

    if (onProgresso) {
      onProgresso(t / duracao);
      await frame_();
    }
  }

  // janela deslizante: conta trocas de cena acima do limiar dentro de JANELA_CENA,
  // amostrada a cada INTERVALO_CENA — igual ao monitorar_cenas() do main.py
  const sinais = [];
  for (let t = cfg.janelaCena; t < duracao; t += cfg.intervaloCena) {
    const cortes = eventosDiff.filter((e) => e.t > t - cfg.janelaCena && e.t <= t && e.diff > cfg.limiarCena).length;
    if (cortes >= cfg.cortesMinCena) {
      sinais.push({ time: t, motivo: "cena_agitada" });
    }
  }
  return sinais;
}

function seekPara(videoEl, tempo) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      videoEl.removeEventListener("seeked", onSeeked);
      resolve();
    };
    videoEl.addEventListener("seeked", onSeeked);
    videoEl.currentTime = tempo;
  });
}
function frame() {
  return new Promise((r) => requestAnimationFrame(r));
}
function frame_() {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Combinação de sinais — espelha _solicitar_corte() do main.py:
// cooldown geral entre cortes + janela de combinação -> tag "viral" quando
// 2+ motivos diferentes aparecem perto um do outro.
// ---------------------------------------------------------------------------
function combinarSinais(sinais, cfg) {
  const ordenados = [...sinais].sort((a, b) => a.time - b.time);
  let ultimoCorte = -Infinity;
  let recentes = [];
  const eventos = [];

  for (const sinal of ordenados) {
    if (sinal.time - ultimoCorte < cfg.cooldownGeral) continue;
    recentes = recentes.filter((s) => sinal.time - s.time < cfg.janelaCombinacao);
    recentes.push(sinal);
    const motivosUnicos = new Set(recentes.map((s) => s.motivo));
    const tag = motivosUnicos.size >= 2 ? "viral" : sinal.motivo;
    ultimoCorte = sinal.time;
    eventos.push({ time: sinal.time, tag });
  }
  return eventos;
}

// ---------------------------------------------------------------------------
// Waveform no hero (decorativo antes do upload, real depois da análise)
// ---------------------------------------------------------------------------
let waveformIdleTimer = null;
function iniciarWaveformIdle() {
  const ctx = els.waveform.getContext("2d");
  const W = els.waveform.width, H = els.waveform.height;
  const N = 64;
  let fase = 0;
  clearInterval(waveformIdleTimer);
  waveformIdleTimer = setInterval(() => {
    ctx.clearRect(0, 0, W, H);
    const barW = W / N;
    for (let i = 0; i < N; i++) {
      const h = (Math.sin(i * 0.35 + fase) * 0.5 + 0.5) * (H * 0.55) + H * 0.08;
      ctx.fillStyle = "rgba(124, 92, 255, 0.35)";
      ctx.fillRect(i * barW + 1, (H - h) / 2, barW - 2, h);
    }
    fase += 0.12;
  }, 90);
}

function desenharWaveformReal(curvaRms, duracao, eventos) {
  clearInterval(waveformIdleTimer);
  const ctx = els.waveform.getContext("2d");
  const W = els.waveform.width, H = els.waveform.height;
  ctx.clearRect(0, 0, W, H);

  const maxRms = Math.max(...curvaRms.map((p) => p.rms), 0.001);
  const barW = W / curvaRms.length;
  curvaRms.forEach((p, i) => {
    const h = Math.max(2, (p.rms / maxRms) * (H * 0.7));
    ctx.fillStyle = "rgba(124, 92, 255, 0.4)";
    ctx.fillRect(i * barW, (H - h) / 2, Math.max(1, barW - 1), h);
  });

  eventos.forEach((ev) => {
    const x = (ev.time / duracao) * W;
    ctx.strokeStyle = ev.tag === "viral" ? "#ff5c8a" : ev.tag === "cena_agitada" ? "#4dd0ff" : "#ffb84d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, H - 4);
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Análise principal
// ---------------------------------------------------------------------------
els.btnAnalisar.addEventListener("click", rodarAnalise);

async function rodarAnalise() {
  if (!state.file) return;
  const cfg = lerConfig();

  els.btnAnalisar.disabled = true;
  els.painelStatus.hidden = false;
  els.painelResultados.hidden = true;
  els.painelVazio.hidden = true;
  els.log.innerHTML = "";
  els.resultsGrid.innerHTML = "";

  try {
    log("🎧 Extraindo e analisando o áudio (picos acima da média)…");
    setProgresso(5, "Analisando áudio…");
    const { sinais: sinaisAudio, curvaRms, duracao } = await detectarPicosAudio(state.file, cfg, (p) =>
      setProgresso(5 + p * 40, "Analisando áudio…")
    );
    log(`Detector de áudio: <b>${sinaisAudio.length}</b> pico(s) encontrado(s).`);

    log("🎬 Analisando cenas (agitação visual)…");
    setProgresso(45, "Analisando cenas…");
    const sinaisCena = await detectarCortesCena(els.videoOculto, duracao, cfg, (p) =>
      setProgresso(45 + p * 45, "Analisando cenas…")
    );
    log(`Detector de cena: <b>${sinaisCena.length}</b> trecho(s) agitado(s).`);

    setProgresso(92, "Combinando sinais…");
    const eventos = combinarSinais([...sinaisAudio, ...sinaisCena], cfg);

    eventos.forEach((ev) => {
      const emoji = ev.tag === "viral" ? "🚀" : ev.tag === "cena_agitada" ? "🎬" : "🔥";
      log(`${emoji} Corte capturado (<b>${ev.tag}</b>) em ${formatarTempo(ev.time)}`);
    });

    setProgresso(100, `Pronto — ${eventos.length} corte(s) encontrado(s).`);
    desenharWaveformReal(curvaRms, duracao, eventos);

    await montarResultados(eventos, cfg, duracao);
  } catch (err) {
    console.error(err);
    log(`⚠️ Erro durante a análise: ${err.message || err}`);
    setProgresso(0, "Falhou — veja o log acima.");
  } finally {
    els.btnAnalisar.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Monta os cards de resultado (com thumbnail real, extraída do vídeo)
// ---------------------------------------------------------------------------
async function montarResultados(eventos, cfg, duracao) {
  if (eventos.length === 0) {
    els.painelVazio.hidden = false;
    els.painelResultados.hidden = true;
    return;
  }

  els.painelResultados.hidden = false;
  els.resultsCount.textContent = `${eventos.length} corte${eventos.length > 1 ? "s" : ""}`;
  els.resultsGrid.innerHTML = "";

  for (const ev of eventos) {
    const inicio = Math.max(0, ev.time - cfg.duracaoCorte);
    const fim = Math.min(duracao, ev.time);
    const clip = { inicio, fim, tag: ev.tag };

    const card = document.createElement("div");
    card.className = "clip-card";

    const emoji = ev.tag === "viral" ? "🚀" : ev.tag === "cena_agitada" ? "🎬" : "🔥";
    const corBadge = ev.tag === "viral" ? "var(--viral)" : ev.tag === "cena_agitada" ? "var(--cena)" : "var(--audio)";

    card.innerHTML = `
      <div class="clip-thumb">
        <img alt="Miniatura do corte" />
        <span class="clip-badge" style="color:${corBadge}">${emoji} ${ev.tag}</span>
        <span class="clip-duration">${formatarTempo(fim - inicio)}</span>
      </div>
      <div class="clip-body">
        <span class="clip-time">${formatarTempo(inicio)} → ${formatarTempo(fim)}</span>
        <div class="clip-actions">
          <button class="btn btn-primary btn-sm" type="button">Baixar corte</button>
        </div>
        <span class="clip-progress">Gravando…</span>
      </div>
    `;
    els.resultsGrid.appendChild(card);

    // thumbnail: frame do meio do clipe
    gerarThumbnail(els.videoOculto, inicio + (fim - inicio) / 2).then((dataUrl) => {
      card.querySelector("img").src = dataUrl;
    });

    const btnBaixar = card.querySelector(".btn-primary");
    const spanProgresso = card.querySelector(".clip-progress");
    btnBaixar.addEventListener("click", () => baixarClipe(clip, btnBaixar, spanProgresso));
  }
}

async function gerarThumbnail(videoEl, tempo) {
  await seekPara(videoEl, tempo);
  const cv = document.createElement("canvas");
  cv.width = 320;
  cv.height = Math.round((320 * videoEl.videoHeight) / videoEl.videoWidth) || 180;
  const ctx = cv.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.75);
}

// ---------------------------------------------------------------------------
// Corte + download real, via captureStream()/MediaRecorder (nativo do
// navegador — sem servidor, sem WASM). Toca o trecho em tempo real e grava.
// ---------------------------------------------------------------------------
async function baixarClipe(clip, btn, spanProgresso) {
  const video = document.createElement("video");
  video.src = state.videoURL;
  video.muted = false;
  video.volume = 0; // não solta som no navegador, mas mantém a trilha capturada
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.left = "-9999px";
  document.body.appendChild(video);

  btn.disabled = true;
  spanProgresso.classList.add("active");
  spanProgresso.textContent = "Preparando…";

  await new Promise((resolve) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
  });
  await seekPara(video, clip.inicio);

  if (!video.captureStream) {
    alert("Seu navegador não suporta gravação direta (captureStream). Tenta no Chrome ou Firefox atualizados.");
    btn.disabled = false;
    spanProgresso.classList.remove("active");
    document.body.removeChild(video);
    return;
  }

  const stream = video.captureStream();
  const mimeCandidatos = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = mimeCandidatos.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const duracaoClipe = clip.fim - clip.inicio;

  const finalizar = () =>
    new Promise((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

  recorder.start();
  video.play();
  spanProgresso.textContent = "Gravando 0%";

  await new Promise((resolve) => {
    const checar = () => {
      const passado = video.currentTime - clip.inicio;
      const pct = Math.min(100, Math.round((passado / duracaoClipe) * 100));
      spanProgresso.textContent = `Gravando ${pct}%`;
      if (video.currentTime >= clip.fim || video.ended) {
        resolve();
      } else {
        requestAnimationFrame(checar);
      }
    };
    checar();
  });

  video.pause();
  await finalizar();
  document.body.removeChild(video);

  const blob = new Blob(chunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${clip.tag}_${formatarTempo(clip.inicio).replace(":", "m")}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  spanProgresso.textContent = "✅ Baixado";
  setTimeout(() => spanProgresso.classList.remove("active"), 2500);
  btn.disabled = false;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function formatarTempo(segundos) {
  segundos = Math.max(0, Math.floor(segundos));
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

iniciarWaveformIdle();

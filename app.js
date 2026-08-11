// =============================================================================
// AI Cutter — Web
// Reimplementação, no navegador, do motor de detecção do app desktop:
//   - Detector 1: pico de áudio (RMS acima da média + N desvios-padrão)
//   - Detector 2: cena agitada (diferença entre frames acima de um limiar)
//   - Detector 3: pico de chat, só no modo live (mensagens/seg acima da
//     média + N desvios-padrão; Twitch via IRC-WebSocket anônimo, Kick beta)
//   - Combinação: cooldown geral + janela de combinação -> tag "viral"
// Tudo roda 100% local (Web Audio API + <canvas> + WebSocket), nada é
// enviado a servidor próprio — a única saída de rede é direto pra Twitch/Kick.
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

  // modo
  btnModoArquivo: document.getElementById("btnModoArquivo"),
  btnModoLive: document.getElementById("btnModoLive"),
  painelUpload: document.getElementById("painelUpload"),
  painelLive: document.getElementById("painelLive"),

  // live
  inputUrlLive: document.getElementById("inputUrlLive"),
  btnVincularLive: document.getElementById("btnVincularLive"),
  btnPararLive: document.getElementById("btnPararLive"),
  liveWarning: document.getElementById("liveWarning"),
  liveMonitor: document.getElementById("liveMonitor"),
  videoLive: document.getElementById("videoLive"),
  meterAudio: document.getElementById("meterAudio"),
  meterCena: document.getElementById("meterCena"),
  meterChat: document.getElementById("meterChat"),
  chatPlataforma: document.getElementById("chatPlataforma"),
  inputCanalChat: document.getElementById("inputCanalChat"),
  logLive: document.getElementById("logLive"),
  painelResultadosLive: document.getElementById("painelResultadosLive"),
  resultsGridLive: document.getElementById("resultsGridLive"),
  resultsCountLive: document.getElementById("resultsCountLive"),
};

// Sliders <-> valores exibidos
const sliders = [
  ["cfgSensibilidade", "valSensibilidade", (v) => `${v}×`],
  ["cfgLimiarCena", "valLimiarCena", (v) => `${v}`],
  ["cfgCortesCena", "valCortesCena", (v) => `${v}`],
  ["cfgDuracao", "valDuracao", (v) => `${v}s`],
  ["cfgCooldown", "valCooldown", (v) => `${v}s`],
  ["cfgCombinacao", "valCombinacao", (v) => `${v}s`],
  ["cfgSensibilidadeChat", "valSensibilidadeChat", (v) => `${v}×`],
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
    sensibilidadeChat: parseFloat(document.getElementById("cfgSensibilidadeChat").value),
    // parâmetros fixos, espelhando o motor original (main.py)
    janelaAudio: 4,
    passoAudio: 3,
    aquecimento: 10, // aquecimento reduzido: aqui já temos o vídeo inteiro, não uma live
    tamanhoBaseline: 40,
    limiarMinimoAudio: 0.015, // piso absoluto (escala 0..1 do Web Audio)
    passoCena: 1, // segundos entre amostras de frame
    janelaCena: 5,
    intervaloCena: 6,
    passoChat: 5, // segundos entre amostras de taxa de mensagens
    limiarMinimoChat: 0.4, // piso absoluto, mensagens/seg
    tamanhoBaselineChat: 24,
    aquecimentoChat: 30,
  };
}

let state = {
  file: null,
  videoURL: null,
  duration: 0,
  live: null, // preenchido quando uma live é vinculada — ver iniciarLive()
};

// ---------------------------------------------------------------------------
// Seletor de modo: Arquivo (VOD) vs Live (URL)
// ---------------------------------------------------------------------------
els.btnModoArquivo.addEventListener("click", () => trocarModo("arquivo"));
els.btnModoLive.addEventListener("click", () => trocarModo("live"));

function trocarModo(modo) {
  const indoParaLive = modo === "live";
  els.btnModoArquivo.classList.toggle("active", !indoParaLive);
  els.btnModoLive.classList.toggle("active", indoParaLive);
  els.painelUpload.hidden = indoParaLive;
  els.painelLive.hidden = !indoParaLive;

  if (indoParaLive) {
    els.painelConfig.hidden = false;
    els.btnAnalisar.hidden = true;
    els.painelStatus.hidden = true;
    els.painelResultados.hidden = true;
    els.painelVazio.hidden = true;
  } else {
    els.btnAnalisar.hidden = false;
    els.painelConfig.hidden = !state.file;
    els.painelResultadosLive.hidden = true;
  }
}

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
      ctx.fillStyle = "rgba(239, 47, 61, 0.35)";
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
    ctx.fillStyle = "rgba(239, 47, 61, 0.4)";
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

// =============================================================================
// MODO LIVE — assiste uma URL de stream (HLS) ao vivo e vai gerando cortes
// automaticamente, igual monitorar_picos_audio()/monitorar_cenas() do
// main.py. Como tudo roda no navegador, precisamos de:
//   - hls.js pra tocar o .m3u8
//   - Web Audio (ScriptProcessor) pra ler o áudio em tempo real
//   - <canvas> amostrando frames pra detectar agitação de cena
//   - um MediaRecorder gravando continuamente em "rolo" (janela deslizante),
//     igual ao buffer que o streamlink escreve em disco no app desktop —
//     quando um corte é detectado, a gente recorta os últimos N segundos
//     desse rolo, sem precisar re-tocar nada.
//
// Limitação real (não dá pra contornar em navegador): só funciona se a URL
// permitir CORS. Muitos links de Kick/Twitch/YouTube não liberam isso pra
// leitura de pixel/áudio via JS — nesse caso a live toca normalmente, mas a
// detecção automática avisa e para. Pra esses casos, o app desktop (que usa
// streamlink) continua sendo o caminho certo.
// =============================================================================

els.btnVincularLive.addEventListener("click", () => {
  const url = els.inputUrlLive.value.trim();
  if (!url) {
    mostrarAvisoLive("Cola a URL do stream (.m3u8) antes de vincular.");
    return;
  }
  iniciarLive(url);
});
els.btnPararLive.addEventListener("click", pararLive);

// ---------------- Resolver link de canal -> URL .m3u8 real ----------------
// Kick e Twitch não expõem o link do stream na própria página (ele é
// carregado via JS lá dentro), então colar "kick.com/fulano" direto no
// player não funciona — o navegador tenta tocar HTML como se fosse um
// manifesto de vídeo. Aqui a gente detecta isso e busca o .m3u8 de verdade
// por trás, usando os mesmos endpoints públicos que os players oficiais
// usam (sem precisar de login).
async function resolverUrlLive(urlBruta) {
  const url = urlBruta.trim();
  if (!url) throw new Error("cola um link antes de continuar");
  if (url.includes(".m3u8")) return { url, plataforma: null, canalDetectado: null };

  let m = url.match(/kick\.com\/([a-zA-Z0-9_-]+)/i);
  if (m) {
    const slug = m[1].toLowerCase();
    logLive(`🔎 Resolvendo link da Kick (#${slug})…`);
    let dados;
    try {
      const resp = await fetch(`https://kick.com/api/v2/channels/${slug}`);
      if (!resp.ok) throw new Error(`canal "${slug}" não encontrado (HTTP ${resp.status})`);
      dados = await resp.json();
    } catch (err) {
      throw new Error(
        `falha ao consultar a Kick pra "${slug}" (${err.message || err}). Isso costuma ser bloqueio de CORS — nesse caso, abre a live no site, pega o .m3u8 pelo DevTools (aba Rede, filtra por "m3u8") e cola ele direto aqui.`
      );
    }
    if (!dados.livestream) throw new Error(`o canal "${slug}" parece estar offline agora`);
    const m3u8 = dados.playback_url || dados.livestream.playback_url || dados.livestream.source;
    if (!m3u8) throw new Error(`a Kick não devolveu um link de stream pra "${slug}"`);
    return { url: m3u8, plataforma: "kick", canalDetectado: slug };
  }

  m = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
  if (m) {
    const slug = m[1].toLowerCase();
    logLive(`🔎 Resolvendo link da Twitch (#${slug})…`);
    const m3u8 = await obterM3u8Twitch(slug);
    return { url: m3u8, plataforma: "twitch", canalDetectado: slug };
  }

  throw new Error(
    'link não reconhecido. Cola a URL .m3u8 direta, ou a página do canal na Kick ("kick.com/canal") ou na Twitch ("twitch.tv/canal")'
  );
}

// Twitch não deixa pegar o .m3u8 direto da URL da página — precisa primeiro
// trocar por um "token de reprodução" via GraphQL (o mesmo client-id público
// que o player oficial embutido usa) e só depois montar o link do usher
// (CDN de HLS da Twitch).
async function obterM3u8Twitch(canal) {
  const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // client-id público, usado pelo player web da própria Twitch
  let tok;
  try {
    const resp = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Client-ID": CLIENT_ID },
      body: JSON.stringify({
        operationName: "PlaybackAccessToken",
        variables: { isLive: true, login: canal, isVod: false, vodID: "", playerType: "site" },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712",
          },
        },
      }),
    });
    const dados = await resp.json();
    tok = dados?.data?.streamPlaybackAccessToken;
  } catch (err) {
    throw new Error(`falha ao consultar a Twitch pra "${canal}" (${err.message || err})`);
  }
  if (!tok) throw new Error(`o canal "${canal}" parece estar offline ou não existe`);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    token: tok.value,
    sig: tok.signature,
    allow_source: "true",
    fast_bread: "true",
  });
  return `https://usher.ttvnw.tv/api/channel/hls/${canal}.m3u8?${params.toString()}`;
}

function mostrarAvisoLive(msg) {
  els.liveWarning.textContent = msg;
  els.liveWarning.hidden = !msg;
}
function logLive(msg) {
  const linha = document.createElement("div");
  linha.className = "log-line";
  linha.innerHTML = msg;
  els.logLive.appendChild(linha);
  els.logLive.scrollTop = els.logLive.scrollHeight;
  if (els.logLive.children.length > 60) els.logLive.removeChild(els.logLive.firstChild);
}

async function iniciarLive(urlBruta) {
  mostrarAvisoLive("");
  els.btnVincularLive.disabled = true;
  els.btnVincularLive.textContent = "Resolvendo link…";

  let url, canalDetectado, plataformaDetectada;
  try {
    const resolvido = await resolverUrlLive(urlBruta);
    url = resolvido.url;
    canalDetectado = resolvido.canalDetectado;
    plataformaDetectada = resolvido.plataforma;
  } catch (err) {
    console.error(err);
    mostrarAvisoLive(`Não consegui resolver esse link: ${err.message || err}`);
    els.btnVincularLive.disabled = false;
    els.btnVincularLive.textContent = "Vincular live";
    return;
  }

  // Se a pessoa colou um link de canal (não o .m3u8 direto) e ainda não
  // configurou o detector de chat, já deixa pré-preenchido com o mesmo
  // canal — economiza um passo, já que geralmente é o mesmo streamer.
  if (plataformaDetectada && canalDetectado && els.chatPlataforma.value === "none" && !els.inputCanalChat.value.trim()) {
    els.chatPlataforma.value = plataformaDetectada;
    els.inputCanalChat.value = canalDetectado;
  }

  els.btnVincularLive.textContent = "Vinculando…";

  const cfg = lerConfig();
  const video = els.videoLive;
  video.crossOrigin = "anonymous";

  const live = {
    cfg,
    tInicio: null,
    ultimoCorte: -Infinity,
    recentes: [],
    baselineAudio: [],
    eventosDiffCena: [],
    intervalos: [],
    stream: null,
    recorder: null,
    headerChunk: null,
    slidingChunks: [],
    ultimoFrameCanvas: document.createElement("canvas"),
    hls: null,
    contadorCortes: 0,
    chatWs: null,
    baselineChat: [],
    chatMsgsJanela: 0,
  };
  state.live = live;

  const dentroDoHls = url.includes(".m3u8") && window.Hls && Hls.isSupported();

  try {
    if (dentroDoHls) {
      const hls = new Hls({ enableWorker: true });
      live.hls = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      await new Promise((resolve, reject) => {
        hls.on(Hls.Events.MANIFEST_PARSED, resolve);
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) reject(new Error(data.details || "Falha ao carregar o HLS"));
        });
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari toca HLS nativamente
      video.src = url;
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("Não consegui carregar essa URL.")), { once: true });
      });
    } else {
      throw new Error("Esse link não parece um HLS (.m3u8) válido, ou seu navegador não suporta HLS.");
    }

    await video.play();
  } catch (err) {
    console.error(err);
    mostrarAvisoLive(
      `Não consegui abrir essa live: ${err.message || err}. Confirma se é uma URL .m3u8 direta e se a origem permite acesso de outros domínios (CORS).`
    );
    els.btnVincularLive.disabled = false;
    els.btnVincularLive.textContent = "Vincular live";
    return;
  }

  els.liveMonitor.hidden = false;
  els.painelResultadosLive.hidden = false;
  els.logLive.innerHTML = "";
  els.resultsGridLive.innerHTML = "";
  live.contadorCortes = 0;
  atualizarContadorLive();
  logLive("🔗 Live conectada. Aquecendo detectores…");

  live.tInicio = performance.now() / 1000;

  // Importante: monta o grafo de áudio (Web Audio) ANTES de pedir o
  // captureStream() — se fizer na ordem contrária, em alguns navegadores a
  // trilha de áudio do stream capturado fica muda.
  try {
    iniciarMonitorAudioLive(live, video);
  } catch (err) {
    console.error(err);
    mostrarAvisoLive(
      "Não consegui analisar o áudio dessa live (provavelmente a origem bloqueia CORS). A detecção de picos de áudio fica desativada, mas a de cena continua tentando."
    );
  }

  try {
    iniciarGravacaoRolante(live, video);
  } catch (err) {
    console.error(err);
    mostrarAvisoLive(
      "A live tocou, mas seu navegador não deixou gravar o buffer (captureStream indisponível). Cortes automáticos ficam desativados nesta sessão."
    );
  }

  iniciarMonitorCenaLive(live, video);

  const plataformaChat = els.chatPlataforma.value;
  const canalChat = els.inputCanalChat.value.trim();
  if (plataformaChat !== "none" && canalChat) {
    try {
      iniciarMonitorChatLive(live, plataformaChat, canalChat);
      logLive(`💬 Conectando ao chat da ${plataformaChat === "twitch" ? "Twitch" : "Kick"} (#${canalChat})…`);
    } catch (err) {
      console.error(err);
      logLive("⚠️ Não consegui iniciar o monitor de chat.");
    }
  }

  els.btnVincularLive.disabled = false;
  els.btnVincularLive.textContent = "Vincular live";
}

function pararLive() {
  const live = state.live;
  if (!live) return;
  live.intervalos.forEach((id) => clearInterval(id));
  if (live.recorder && live.recorder.state !== "inactive") live.recorder.stop();
  if (live.scriptNode) live.scriptNode.disconnect();
  if (live.audioCtx) live.audioCtx.close();
  if (live.hls) live.hls.destroy();
  if (live.chatWs) {
    try {
      live.chatWs.onclose = null;
      live.chatWs.close();
    } catch (_err) {}
  }
  els.videoLive.pause();
  els.videoLive.removeAttribute("src");
  els.liveMonitor.hidden = true;
  state.live = null;
  logLive("⏹ Monitoramento encerrado.");
}

// ---------------- Gravação em "rolo" (janela deslizante) ----------------
function iniciarGravacaoRolante(live, video) {
  const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
  if (!stream) throw new Error("captureStream indisponível");
  live.stream = stream;

  const mimeCandidatos = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = mimeCandidatos.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  live.recorder = recorder;
  live.mime = mime;

  const margemExtra = 12; // segundos de folga além da duração do corte
  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    const t = performance.now() / 1000 - live.tInicio;
    if (!live.headerChunk) {
      live.headerChunk = e.data; // primeiro chunk carrega o cabeçalho do container
      return;
    }
    live.slidingChunks.push({ blob: e.data, t });
    const limite = live.cfg.duracaoCorte + margemExtra;
    while (live.slidingChunks.length && t - live.slidingChunks[0].t > limite) {
      live.slidingChunks.shift();
    }
  };
  recorder.start(1000); // 1 chunk por segundo
}

function recortarClipeAoVivo(live, motivo) {
  if (!live.headerChunk) return null;
  const agora = performance.now() / 1000 - live.tInicio;
  const inicio = Math.max(0, agora - live.cfg.duracaoCorte);
  const janela = live.slidingChunks.filter((c) => c.t >= inicio);
  if (janela.length === 0) return null;
  const blob = new Blob([live.headerChunk, ...janela.map((c) => c.blob)], { type: live.mime });
  return { blob, duracaoAprox: agora - (janela[0]?.t ?? inicio), motivo, tempo: agora };
}

// ---------------- Detector 1 (live): pico de áudio ----------------
function iniciarMonitorAudioLive(live, video) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  live.audioCtx = audioCtx;

  video.muted = false; // já estamos numa resposta a clique do usuário, pode soltar o áudio
  const fonte = audioCtx.createMediaElementSource(video);
  const tamJanelaAmostras = Math.floor(live.cfg.janelaAudio * audioCtx.sampleRate);
  const anelBuffer = new Float32Array(tamJanelaAmostras);
  let posAnel = 0;
  let preenchido = false;

  const processador = audioCtx.createScriptProcessor(4096, 1, 1);
  live.scriptNode = processador;
  processador.onaudioprocess = (e) => {
    const dados = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < dados.length; i++) {
      anelBuffer[posAnel] = dados[i];
      posAnel = (posAnel + 1) % tamJanelaAmostras;
      if (posAnel === 0) preenchido = true;
    }
  };
  // fonte -> destino (você ouve a live normalmente) e fonte -> processador
  // (análise, sem afetar o som). ScriptProcessorNode só dispara
  // onaudioprocess se estiver conectado a algum destino, então passa por um
  // ganho zerado só pra isso, sem duplicar o áudio.
  fonte.connect(audioCtx.destination);
  const ganhoMudo = audioCtx.createGain();
  ganhoMudo.gain.value = 0;
  fonte.connect(processador);
  processador.connect(ganhoMudo);
  ganhoMudo.connect(audioCtx.destination);

  const intervalId = setInterval(() => {
    if (!preenchido) return;
    let soma = 0;
    for (let i = 0; i < anelBuffer.length; i++) soma += anelBuffer[i] * anelBuffer[i];
    const rms = Math.sqrt(soma / anelBuffer.length);

    els.meterAudio.style.width = `${Math.min(100, rms * 800)}%`;

    const tempoDecorrido = performance.now() / 1000 - live.tInicio;
    if (tempoDecorrido < 30) return; // aquecimento, igual AQUECIMENTO_AUDIO

    if (live.baselineAudio.length >= 5) {
      const media = live.baselineAudio.reduce((a, b) => a + b, 0) / live.baselineAudio.length;
      const variancia = live.baselineAudio.reduce((a, b) => a + (b - media) ** 2, 0) / live.baselineAudio.length;
      const desvio = Math.sqrt(variancia) || 0.0001;
      const limiar = Math.max(media + live.cfg.sensibilidadeAudio * desvio, live.cfg.limiarMinimoAudio);
      if (rms > limiar) processarSinalLive(live, "audio_pico");
    }
    live.baselineAudio.push(rms);
    if (live.baselineAudio.length > live.cfg.tamanhoBaseline) live.baselineAudio.shift();
  }, live.cfg.passoAudio * 1000);
  live.intervalos.push(intervalId);
}

// ---------------- Detector 2 (live): cena agitada ----------------
function iniciarMonitorCenaLive(live, video) {
  const LARGURA = 48, ALTURA = 27;
  const cv = live.ultimoFrameCanvas;
  cv.width = LARGURA;
  cv.height = ALTURA;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  let anterior = null;

  const idColeta = setInterval(() => {
    if (video.readyState < 2) return;
    try {
      ctx.drawImage(video, 0, 0, LARGURA, ALTURA);
      const frame = ctx.getImageData(0, 0, LARGURA, ALTURA).data;
      const t = performance.now() / 1000 - live.tInicio;
      if (anterior) {
        let somaDiff = 0;
        for (let i = 0; i < frame.length; i += 4) {
          const l1 = 0.299 * anterior[i] + 0.587 * anterior[i + 1] + 0.114 * anterior[i + 2];
          const l2 = 0.299 * frame[i] + 0.587 * frame[i + 1] + 0.114 * frame[i + 2];
          somaDiff += Math.abs(l1 - l2);
        }
        const diff = somaDiff / ((frame.length / 4) * 255);
        live.eventosDiffCena.push({ t, diff });
        els.meterCena.style.width = `${Math.min(100, (diff / live.cfg.limiarCena) * 60)}%`;
        const limite = live.cfg.janelaCena + 5;
        while (live.eventosDiffCena.length && t - live.eventosDiffCena[0].t > limite) {
          live.eventosDiffCena.shift();
        }
      }
      anterior = frame;
    } catch (err) {
      // canvas "tainted" por CORS — para de tentar e avisa uma vez
      clearInterval(idColeta);
      mostrarAvisoLive(
        "A origem dessa live bloqueia leitura de frames (CORS), então a detecção de cena não funciona aqui. Áudio continua tentando, se disponível."
      );
    }
  }, live.cfg.passoCena * 1000);
  live.intervalos.push(idColeta);

  const idJanela = setInterval(() => {
    const t = performance.now() / 1000 - live.tInicio;
    if (t < 30) return;
    const cortes = live.eventosDiffCena.filter((e) => e.t > t - live.cfg.janelaCena && e.diff > live.cfg.limiarCena).length;
    if (cortes >= live.cfg.cortesMinCena) processarSinalLive(live, "cena_agitada");
  }, live.cfg.intervaloCena * 1000);
  live.intervalos.push(idJanela);
}

// ---------------- Detector 3 (live): pico de mensagens no chat ----------------
// Mesma lógica do áudio: em vez de RMS, medimos "mensagens por segundo" e
// comparamos com uma baseline móvel (média + N desvios-padrão). Quando o
// chat "explode" (raid, hype, reação forte), isso vira um sinal de corte —
// e, se bater no mesmo tempo que áudio ou cena, o clipe sai marcado "viral".
function iniciarMonitorChatLive(live, plataforma, canal) {
  if (plataforma === "twitch") {
    conectarChatTwitch(live, canal);
  } else if (plataforma === "kick") {
    conectarChatKick(live, canal);
  }
}

// Contador de mensagens compartilhado pelas duas plataformas + laço de
// amostragem/baseline, pra não duplicar a lógica de detecção.
function iniciarContadorChat(live) {
  const idJanela = setInterval(() => {
    const taxa = live.chatMsgsJanela / live.cfg.passoChat; // mensagens/seg
    live.chatMsgsJanela = 0;

    els.meterChat.style.width = `${Math.min(100, taxa * 25)}%`;

    const tempoDecorrido = performance.now() / 1000 - live.tInicio;
    if (tempoDecorrido < live.cfg.aquecimentoChat) return;

    if (live.baselineChat.length >= 5) {
      const media = live.baselineChat.reduce((a, b) => a + b, 0) / live.baselineChat.length;
      const variancia = live.baselineChat.reduce((a, b) => a + (b - media) ** 2, 0) / live.baselineChat.length;
      const desvio = Math.sqrt(variancia) || 0.0001;
      const limiar = Math.max(media + live.cfg.sensibilidadeChat * desvio, live.cfg.limiarMinimoChat);
      if (taxa > limiar) processarSinalLive(live, "chat_pico");
    }
    live.baselineChat.push(taxa);
    if (live.baselineChat.length > live.cfg.tamanhoBaselineChat) live.baselineChat.shift();
  }, live.cfg.passoChat * 1000);
  live.intervalos.push(idJanela);
}

// Twitch: chat IRC exposto via WebSocket, aceita login anônimo
// ("justinfanNNNNN") sem precisar de token — funciona 100% no navegador.
function conectarChatTwitch(live, canal) {
  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  live.chatWs = ws;
  const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;

  ws.onopen = () => {
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send(`NICK ${nick}`);
    ws.send(`JOIN #${canal.toLowerCase()}`);
    logLive(`💬 Conectado ao chat da Twitch (#${canal.toLowerCase()}).`);
  };
  ws.onmessage = (evt) => {
    const linhas = evt.data.split("\r\n").filter(Boolean);
    for (const linha of linhas) {
      if (linha.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        continue;
      }
      if (linha.includes("PRIVMSG")) live.chatMsgsJanela++;
    }
  };
  ws.onerror = () => {
    mostrarAvisoLive("Não consegui conectar ao chat da Twitch (canal errado ou instabilidade de rede).");
  };
  ws.onclose = () => {
    if (state.live === live) logLive("💬 Conexão com o chat encerrada.");
  };

  iniciarContadorChat(live);
}

// Kick: não tem um endpoint público estável/documentado como o da Twitch —
// a gente precisa primeiro descobrir o "chatroom id" do canal via API REST
// e depois assinar o canal certo no Pusher (infra de websocket que a Kick
// usa). Isso pode falhar por CORS dependendo de mudanças no site deles; por
// isso é tratado como "beta", com aviso claro em vez de falha silenciosa.
async function conectarChatKick(live, canal) {
  try {
    const resp = await fetch(`https://kick.com/api/v2/channels/${canal.toLowerCase()}`);
    if (!resp.ok) throw new Error(`canal não encontrado (HTTP ${resp.status})`);
    const dados = await resp.json();
    const chatroomId = dados?.chatroom?.id;
    if (!chatroomId) throw new Error("não achei o chatroom desse canal");

    const ws = new WebSocket(
      "wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.6.0&flash=false"
    );
    live.chatWs = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${chatroomId}.v2` } }));
      logLive(`💬 Conectado ao chat da Kick (#${canal.toLowerCase()}), modo beta.`);
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.event === "App\\Events\\ChatMessageEvent") live.chatMsgsJanela++;
      } catch (_err) {
        // frame que não é JSON de mensagem (ping/pong interno do pusher) — ignora
      }
    };
    ws.onerror = () => {
      mostrarAvisoLive("O chat da Kick não respondeu (a integração é experimental e pode mudar sem aviso).");
    };

    iniciarContadorChat(live);
  } catch (err) {
    console.error(err);
    mostrarAvisoLive(
      `Não consegui ligar no chat da Kick (${err.message || err}). Isso é esperado às vezes — o site bloqueia CORS pra esse endpoint dependendo da região/CDN. Áudio e cena continuam funcionando normalmente.`
    );
  }
}

// ---------------- Combinação de sinais (live) — igual _solicitar_corte() ----------------
function processarSinalLive(live, motivo) {
  const agora = performance.now() / 1000 - live.tInicio;
  if (agora - live.ultimoCorte < live.cfg.cooldownGeral) return;
  live.recentes = live.recentes.filter((s) => agora - s.time < live.cfg.janelaCombinacao);
  live.recentes.push({ time: agora, motivo });
  const motivosUnicos = new Set(live.recentes.map((s) => s.motivo));
  const tag = motivosUnicos.size >= 2 ? "viral" : motivo;
  live.ultimoCorte = agora;
  dispararCorteLive(live, tag);
}

function dispararCorteLive(live, tag) {
  const emoji = tag === "viral" ? "🚀" : tag === "cena_agitada" ? "🎬" : tag === "chat_pico" ? "💬" : "🔥";
  logLive(`${emoji} Corte capturado (<b>${tag}</b>)`);

  const resultado = recortarClipeAoVivo(live, tag);
  live.contadorCortes++;
  atualizarContadorLive();

  const card = document.createElement("div");
  card.className = "clip-card";
  const corBadge =
    tag === "viral" ? "var(--viral)" : tag === "cena_agitada" ? "var(--cena)" : tag === "chat_pico" ? "var(--chat)" : "var(--audio)";

  const thumb = document.createElement("canvas");
  thumb.width = 320;
  thumb.height = Math.round((320 * els.videoLive.videoHeight) / els.videoLive.videoWidth) || 180;
  thumb.getContext("2d").drawImage(els.videoLive, 0, 0, thumb.width, thumb.height);

  card.innerHTML = `
    <div class="clip-thumb">
      <img alt="Miniatura do corte" src="${thumb.toDataURL("image/jpeg", 0.75)}" />
      <span class="clip-badge" style="color:${corBadge}">${emoji} ${tag}</span>
    </div>
    <div class="clip-body">
      <span class="clip-time">capturado às ${new Date().toLocaleTimeString("pt-BR")}</span>
      <div class="clip-actions">
        <button class="btn btn-primary btn-sm" type="button" ${resultado ? "" : "disabled"}>
          ${resultado ? "Baixar corte" : "Buffer indisponível"}
        </button>
      </div>
    </div>
  `;
  els.resultsGridLive.prepend(card);

  if (resultado) {
    const btn = card.querySelector(".btn-primary");
    btn.addEventListener("click", () => {
      const url = URL.createObjectURL(resultado.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${tag}_live_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }
}

function atualizarContadorLive() {
  const n = state.live?.contadorCortes || 0;
  els.resultsCountLive.textContent = `${n} corte${n === 1 ? "" : "s"}`;
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

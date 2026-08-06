# AI Cutter — Web

Versão web (HTML + CSS + JS puro, sem build) do motor de detecção do AI
Cutter desktop. Roda **inteiramente no navegador** — nenhum vídeo é enviado
a servidor nenhum, então dá pra hospedar de graça no GitHub Pages.

## O que ela faz

Você sobe um vídeo (VOD/gravação de live), e ela:

1. **Detector de áudio** — analisa o volume (RMS) em janelas de tempo e
   marca um "pico" sempre que ele fica muito acima da média recente
   (mesma lógica do `monitorar_picos_audio()` do app desktop: baseline
   móvel + desvio-padrão).
2. **Detector de cena** — compara frames a cada segundo e marca "cena
   agitada" quando há várias mudanças bruscas de imagem numa janela curta
   (mesma lógica do `monitorar_cenas()`).
3. **Combinação de sinais** — junta os dois detectores com cooldown e
   janela de combinação, igual ao `_solicitar_corte()` do original: se
   os dois detectores disparam perto um do outro, o corte vira `viral` 🚀;
   senão fica `audio_pico` 🔥 ou `cena_agitada` 🎬.
4. Gera um cartão por corte, com miniatura, faixa de tempo e um botão
   **Baixar corte**, que grava o trecho de verdade (via
   `HTMLVideoElement.captureStream()` + `MediaRecorder`, nativo do
   navegador) e baixa um `.webm`.

Os parâmetros (sensibilidade, duração do corte, cooldown etc.) ficam numa
tela de ajustes interativa, com os mesmos valores padrão do app Python.

## Rodar localmente

Não precisa de build nem servidor especial. Duas opções:

```bash
# opção 1: abrir direto
open index.html

# opção 2 (recomendado, evita restrições de alguns navegadores com file://)
python3 -m http.server 8000
# depois abra http://localhost:8000
```

## Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (ex: `ai-cutter-web`).
2. Suba estes 4 arquivos na raiz do repositório: `index.html`, `style.css`,
   `app.js`, `favicon.ico` (e este `README.md`, opcional).
   ```bash
   git init
   git add .
   git commit -m "AI Cutter web"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/ai-cutter-web.git
   git push -u origin main
   ```
3. No GitHub, vá em **Settings → Pages**.
4. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
5. Em **Branch**, escolha `main` e a pasta `/ (root)` → **Save**.
6. Espere ~1 minuto e o site fica disponível em:
   `https://SEU_USUARIO.github.io/ai-cutter-web/`

Não precisa de nenhuma configuração extra (sem chaves de API, sem backend,
sem variáveis de ambiente) — é só HTML/CSS/JS estático.

## Limitações (por ser 100% client-side)

- **Não monitora lives ao vivo** (isso exigiria um servidor rodando
  `streamlink` + `ffmpeg`, o que o GitHub Pages não faz). Aqui você sobe o
  vídeo já gravado (ex.: exporta o VOD da live) e ela acha os melhores
  momentos nele.
- A análise de cena faz a amostragem "pulando" no vídeo (`seek`), então
  vídeos muito longos (+1h) podem demorar alguns minutos pra analisar —
  tudo processado no seu computador, não trava por causa de rede.
- O corte final sai em `.webm` (formato que o navegador consegue gravar
  nativamente). Se precisar de `.mp4`, dá pra converter depois com
  qualquer conversor (ex. `ffmpeg -i corte.webm corte.mp4`).
- Compatível com navegadores baseados em Chromium e Firefox atualizados
  (usa `MediaRecorder` e `captureStream`, que o Safari suporta parcialmente).

## Estrutura

```
ai-cutter-web/
├── index.html   # estrutura da página (upload, config, resultados)
├── style.css    # identidade visual (mesma paleta do app desktop)
├── app.js       # motor de detecção + corte/gravação dos clipes
├── favicon.ico
└── README.md
```

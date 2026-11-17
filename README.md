# Transcriber

A desktop app that turns speech into text: talk into your microphone — or capture the audio playing through a system output device — and the recognized text is automatically typed into whatever application has focus. Runs in Docker with CUDA GPU support.

## Features

### Audio capture

- **Input devices** — microphones and other capture devices (ALSA host via cpal; ALSA routes are collapsed per physical device, preferring `plughw`);
- **Output devices** — speakers, headsets, HDMI: select a sink and the app captures whatever is playing through it (PipeWire host, monitor capture) — useful for transcribing calls, videos, meetings;
- Hot-plug friendly: devices plugged in after the app starts appear after pressing Refresh (bind-mounted `/dev/snd` + a device-cgroup rule for the whole ALSA major);
- A live oscilloscope (canvas waveform) of the currently monitored stream.

### Transcription

- **Automatic speech-to-text**: a built-in voice activity detector (adaptive noise floor, pre-roll capture, ~0.9 s end-of-speech pause) slices the audio into utterances — no button pressing needed;
- **Live drafts**: while you are still speaking, a partial transcription of the growing phrase is shown on top of the chat (updated every ~2 s);
- **Chat-style transcript**: each finalized utterance is a message in a full-height chat column; newest on top, with auto-scroll;
- **Language selection** — every language the loaded model supports, plus `auto` (see the table below);
- **On-the-fly model switching** — every `ggml` model found in `models/` is available as a chip in the UI; switching reloads the whisper context without restarting the app (~1 s);
- **Supported models** — any `ggml` file in `models/`: tiny/base/small/medium/large (incl. quantized q5_0/q5_1/q8_0 variants and large-v3-turbo); switching reloads the whisper context without restarting the app (~1 s).

### Text insertion

- **Auto-insert** — each finalized phrase is typed into whatever application has focus (enigo, X11 XTest); suppressed while the Transcriber window itself is focused, so text never ends up in the app's own UI;
- **Insert on/off** toggle persisted across restarts;
- **Copy to clipboard** — the whole transcript in chronological order (native clipboard plugin with web-API and `execCommand` fallbacks);
- Transcription errors are surfaced as inline notifications.

### Supported languages

99 languages via the whisper language table, selectable per transcription:

| `en` | `zh` | `de` | `es` | `ru` | `ko` | `fr` | `ja` | `pt` | `tr` |
|---|---|---|---|---|---|---|---|---|---|
| `pl` | `ca` | `nl` | `ar` | `sv` | `it` | `id` | `hi` | `fi` | `vi` |
| `he` | `uk` | `el` | `ms` | `cs` | `ro` | `da` | `hu` | `ta` | `no` |
| `th` | `ur` | `hr` | `bg` | `lt` | `la` | `mi` | `ml` | `cy` | `sk` |
| `te` | `fa` | `lv` | `bn` | `sr` | `az` | `sl` | `kn` | `et` | `mk` |
| `br` | `eu` | `is` | `hy` | `ne` | `mn` | `bs` | `kk` | `sq` | `sw` |
| `gl` | `mr` | `pa` | `si` | `km` | `sn` | `yo` | `so` | `af` | `oc` |
| `ka` | `be` | `tg` | `sd` | `gu` | `am` | `yi` | `lo` | `uz` | `fo` |
| `ht` | `ps` | `tk` | `nn` | `mt` | `sa` | `lb` | `my` | `bo` | `tl` |
| `mg` | `as` | `tt` | `haw` | `ln` | `ha` | `ba` | `jw` | `su` | `yue` |


Plus `auto` (language detection). The language is persisted across restarts and applied to every transcription.


### GPU acceleration

- whisper.cpp is built with the CUDA backend (`GGML_CUDA`) — transcription runs on the NVIDIA GPU;
- the runtime CUDA libraries (`libcudart`, `libcublas`, `libcublasLt`) are bundled inside the AppImage; the NVIDIA driver (`libcuda.so`) comes from the target machine;
- automatic CPU fallback when no GPU device nodes are present (`/dev/nvidia*` detection) or when CUDA initialization fails — the same build runs on GPU-only and CPU-only machines;
- model loading speed on the reference GPU (GTX 1650 SUPER): ~0.2–0.6 s regardless of model size;
- the CUDA 13.1 toolkit supports Turing (sm_75) and newer — older GPUs fall back to the CPU.

### Supported GPUs

| Compute capability | Architecture | Example GPUs | Status |
|---|---|---|---|
| NVIDIA (sm_75+) | Turing … Blackwell | GTX 16xx, RTX 20xx–50xx, T4, H100 | **supported** — tested on GTX 1650 SUPER |
| AMD | — | RX series (ROCm not bundled) | **fallback** — runs on the CPU |
| Intel | — | Arc series | **fallback** — runs on the CPU |
| CPU | — | any x86_64 machine | **fallback** — supported |

\* pre-Turing NVIDIA cards (Maxwell, Pascal, Volta) are not supported by CUDA 13 — they fall back to the CPU.

On unsupported GPUs the app runs on the CPU automatically (see GPU acceleration above).

### Persistence

Everything survives app restarts and container recreation:

- the selected device (the capture monitor auto-resumes on startup),
- sensitivity, language, model, the Insert toggle,
- the whole transcript chat (stored in `transcript.json` inside the app data directory, which is bind-mounted from the host),
- the chat is not cleared by auto-insert — only by the **Clear** button.

## Running

```bash
docker compose up frontend transcriber
```

- `frontend` — the Vite dev server on `http://localhost:9999` (the Tauri window loads its UI from there);
- `transcriber` — the Rust application (`cargo tauri dev`), the window opens on the host desktop.

Container requirements, already wired in `docker-compose.yaml` / `docker/transcriber/Dockerfile`:

- NVIDIA GPU (`deploy.resources.reservations.devices`) and the CUDA 13.1 toolkit baked into the image (whisper.cpp is built with `GGML_CUDA`);
- `/dev/snd` (bind mount + `device_cgroup_rules: c 116:* rwm` for hot-plugging devices);
- user sockets: `pipewire-0` (output capture), Wayland/X11 (the window and XTest typing);
- Node.js 22 + pnpm, Rust (stable), cmake, g++-14 (the nvcc host compiler), pipewire-bin.

## Models

Stored in `transcriber/src-tauri/models/` (downloaded from [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)):

| File | Size | Notes |
|---|---|---|
| `ggml-base.bin` | 148 MB | baseline quality |
| `ggml-small-q5_1.bin` | 190 MB | fast, better than base |
| `ggml-medium-q5_0.bin` | 539 MB | good quality (current default) |
| `ggml-large-v3-turbo-q5_0.bin` | 574 MB | close to large-v3 |

Pick one with the chips in the UI (the choice is remembered). On startup the best available model is loaded; the priority can be overridden via `WHISPER_MODEL_PATH`. Without a GPU the app automatically falls back to the CPU.

## Libraries

**Frontend**

- [React](https://react.dev/) 19 + [TypeScript](https://www.typescriptlang.org/) — UI (class-based root component)
- [Vite](https://vite.dev/) — dev server and bundler
- [Bulma](https://bulma.io/) — CSS framework (light and dark themes via `data-theme`)
- [react-icons](https://github.com/react-icons/react-icons) — Font Awesome SVG icons
- [@tauri-apps/api](https://v2.tauri.app/reference/javascript/api/) + [@tauri-apps/plugin-clipboard-manager](https://v2.tauri.app/reference/javascript/clipboard/) — IPC and native clipboard writes

**Rust / Tauri**

- [Tauri v2](https://v2.tauri.app/) — application framework (window, IPC, events)
- [tauri-plugin-opener](https://v2.tauri.app/plugin/opener/) — URL/file opening
- [tauri-plugin-clipboard-manager](https://v2.tauri.app/plugin/clipboard-manager/) — native clipboard writes (WebKit blocks the web Clipboard API)
- [cpal](https://github.com/RustAudio/cpal) — audio capture (ALSA host for inputs, PipeWire host for output/sink monitor capture)
- [whisper-rs](https://github.com/thewh1teagle/whisper-rs) — whisper.cpp bindings (CUDA feature, ggml models)
- [enigo](https://github.com/enigo-rs/enigo) — keyboard input simulation (X11 XTest) for text insertion
- [serde](https://serde.rs/) / [serde_json](https://github.com/serde-rs/json) — serialization for IPC and the transcript file
- [rust-pipewire](https://gitlab.freedesktop.org/pipewire/pipewire-rs) / [alsa](https://github.com/diwic/alsa-rs) — pulled in through cpal's backends

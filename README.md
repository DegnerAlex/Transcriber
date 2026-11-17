# Transcriber

A desktop app that turns speech into text: talk into your microphone — or capture the audio playing through a system output device — and the recognized text is automatically typed into whatever application has focus. Runs in Docker with CUDA GPU support.

<img width="800" height="600" alt="Bildschirmfoto_20261117_220925" src="https://github.com/user-attachments/assets/aa0d075b-0fbe-4aa0-b6e5-4f4f232166be" />


## Features

- **Audio capture**:
  - microphones and other input devices (ALSA via cpal);
  - **output devices** (sinks) — transcribe what is playing in the system (PipeWire host, monitor capture);
- **Automatic phrase slicing** — a built-in VAD with an adaptive noise floor; a live draft appears while you are speaking, the final text is appended after ~0.9 s of silence;
- **On-the-fly model switching** — every `ggml` model found in `models/` is available as a chip in the UI, no restart required;
- **Language selection** — every language the loaded model supports, plus `auto`;
- **Sensitivity** (software gain, 0–400 %) and an **auto-insert toggle** (Insert on/off);
- **Copy-to-clipboard** for the whole transcript (native clipboard plugin);
- Persistence: device, language, model, sensitivity, the Insert toggle and the transcript survive restarts (localStorage + a JSON file in the app data directory + automatic monitor resume).

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


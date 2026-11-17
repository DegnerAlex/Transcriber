import { Component } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DeviceList } from "./components/DeviceList";
import type { AudioInputDevice } from "./components/DeviceList";
import { Waveform } from "./components/Waveform";
import "./App.css";

interface AudioInputConfig {
  channels: number;
  sampleRate: number;
  sampleFormat: string;
}

interface AppState {
  devices: AudioInputDevice[];
  error: string | null;
  selected: AudioInputDevice | null;
  monitorError: string | null;
  gain: number;
  language: string;
  languages: string[];
  languagesError: string | null;
  languagesOpen: boolean;
  transcript: string | null;
  partial: string | null;
  typeError: string | null;
}

interface TranscriptionPayload {
  text: string;
  segments: number;
}

class App extends Component<Record<string, never>, AppState> {
  /** Unlisten functions for the Tauri event subscriptions. */
  private unlisteners: Array<() => void> = [];
  /** Set on unmount: late-resolving listener promises must self-detach. */
  private disposed = false;
  /** Monotonic id of the latest start_audio_monitor request. */
  private monitorSeq = 0;

  state: AppState = {
    devices: [],
    error: null,
    selected: null,
    monitorError: null,
    gain: 100,
    language: "auto",
    languages: [],
    languagesError: null,
    languagesOpen: false,
    transcript: null,
    partial: null,
    typeError: null,
  };

  componentDidMount(): void {
    // Attach listeners synchronously so StrictMode's simulated unmount
    // cannot race the (async) listen() promises.
    this.attachTranscriptionListeners();
    this.refreshDevices();
    invoke<string[]>("list_transcription_languages")
      .then((languages) => {
        invoke("debug_log", {
          message: `languages fetched: ${languages.length}`,
        }).catch(() => {});
        this.setState({ languages });
      })
      .catch((e) => {
        invoke("debug_log", { message: `languages error: ${e}` }).catch(
          () => {},
        );
        this.setState({ languagesError: String(e) });
      });
  }

  componentDidUpdate(
    _prevProps: Record<string, never>,
    prevState: AppState,
  ): void {
    if (prevState.selected !== this.state.selected) {
      const selected = this.state.selected;
      if (selected) {
        // Each freshly selected device starts at unity gain.
        this.setState({ gain: 100 });
        const seq = ++this.monitorSeq;
        invoke("start_audio_monitor", {
          driver: selected.driver,
          name: selected.name,
        })
          .then(() => {
            if (seq === this.monitorSeq) this.setState({ monitorError: null });
          })
          .catch((e) => {
            if (seq === this.monitorSeq) {
              this.setState({ monitorError: String(e) });
            }
          });
      } else {
        ++this.monitorSeq;
        invoke("stop_audio_monitor").catch(() => {});
      }
    }
  }

  componentWillUnmount(): void {
    this.disposed = true;
    this.unlisteners.forEach((stop) => stop());
    this.unlisteners = [];
    if (this.state.selected) {
      invoke("stop_audio_monitor").catch(() => {});
    }
  }

  private attachTranscriptionListeners(): void {
    // Automatic transcription results arrive as events from the Rust VAD/
    // whisper pipeline; each finalized utterance is appended on its own line.
    // A listener that resolves after unmount detaches itself immediately,
    // otherwise StrictMode's double mount leaves duplicates attached and
    // every utterance would be appended twice.
    const register = (stop: () => void) => {
      if (this.disposed) {
        stop();
        return;
      }
      this.unlisteners.push(stop);
    };

    listen<TranscriptionPayload>("transcription", (event) => {
      const text = event.payload.text.trim();
      invoke("debug_log", {
        message: `transcription event: "${text.slice(0, 40)}"`,
      }).catch(() => {});
      this.setState({ partial: null });
      if (!text) return;
      this.setState((state) => ({
        transcript:
          state.transcript && !state.transcript.startsWith("Error:")
            ? `${state.transcript}\n${text}`
            : text,
      }));
    }).then((stop) => register(stop));

    listen<TranscriptionPayload>("transcription-partial", (event) => {
      this.setState({ partial: event.payload.text.trim() || null });
    }).then((stop) => register(stop));

    listen<string>("transcription-error", (event) => {
      this.setState({ transcript: `Error: ${event.payload}` });
    }).then((stop) => register(stop));
  }

  private async refreshDevices(): Promise<void> {
    try {
      const devices = await invoke<AudioInputDevice[]>(
        "list_audio_input_devices",
      );
      this.setState({ devices, error: null });
    } catch (e) {
      this.setState({ error: String(e) });
    }
  }

  /** Clicking the selected device again stops monitoring it. */
  private toggleDevice = (device: AudioInputDevice): void => {
    this.setState((state) =>
      state.selected !== null &&
      state.selected.name === device.name &&
      state.selected.driver === device.driver
        ? { selected: null }
        : { selected: device },
    );
  };

  private changeGain = (value: number): void => {
    this.setState({ gain: value });
    invoke("set_audio_monitor_gain", { gainPercent: value }).catch(() => {});
  };

  private changeLanguage = (value: string): void => {
    this.setState({ language: value, languagesOpen: false });
    invoke("set_transcription_language", { language: value }).catch(() => {});
  };

  private typeTranscript = async (): Promise<void> => {
    const transcript = this.state.transcript;
    if (!transcript) return;
    this.setState({ typeError: null });
    try {
      await invoke("type_text", { text: transcript });
      // Text delivered — clear it for the next transcription.
      this.setState({ transcript: null, partial: null });
    } catch (e) {
      this.setState({ typeError: String(e) });
    }
  };

  private clearTranscript = (): void => {
    this.setState({ transcript: null, partial: null, typeError: null });
  };

  render() {
    const {
      devices,
      error,
      selected,
      monitorError,
      gain,
      language,
      languages,
      languagesError,
      languagesOpen,
      transcript,
      partial,
      typeError,
    } = this.state;

    return (
      <section className="section is-flex-grow-1 compact">
        <div className="container is-max-desktop">
          <div className="level is-mobile mb-2">
            <div className="level-left">
              <h1 className="title is-5 mb-0">Audio Input Devices</h1>
            </div>
            <div className="level-right">
              <button
                type="button"
                className="button is-small is-outlined is-info"
                onClick={() => this.refreshDevices()}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="box p-3 live-panel">
            <div className="is-size-7 has-text-weight-semibold mb-1">
              {selected
                ? `Live: ${selected.name}`
                : "Live input — select a device below"}
            </div>
            {monitorError && (
              <p className="notification is-warning is-light py-1 px-2 is-size-7">
                {monitorError}
              </p>
            )}
            <Waveform active={selected !== null} />
            <div className="is-flex is-align-items-center mt-1">
              <span className="is-size-7 has-text-grey mr-2">Sensitivity</span>
              <input
                type="range"
                min={0}
                max={400}
                step={5}
                value={gain}
                disabled={selected === null || !!monitorError}
                onChange={(e) => this.changeGain(Number(e.currentTarget.value))}
                className="gain-slider mr-2"
              />
              <span className="is-size-7 gain-value">{Math.round(gain)}%</span>
            </div>
            <div className="is-flex is-align-items-center mt-2">
              <span className="is-size-7 has-text-grey mr-2">Language</span>
              {languagesError && (
                <span className="is-size-7 has-text-danger">
                  {languagesError}
                </span>
              )}
              <button
                type="button"
                title="Change transcription language"
                className={"button is-small" + (language === "auto" ? " is-info" : " is-light")}
                onClick={() =>
                  this.setState((state) => ({
                    languagesOpen: !state.languagesOpen,
                  }))
                }
              >
                {language}
              </button>
            </div>
            {languagesOpen && (
              <div className="language-chips mt-1">
                {[
                  ["auto", "auto"] as [string, string],
                  ...languages.map((code) => [code, code] as [string, string]),
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      "button is-small" +
                      (language === value ? " is-info" : " is-light")
                    }
                    onClick={() => this.changeLanguage(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-1">
              <p
                className={
                  "transcript" + (transcript || partial ? "" : " is-idle")
                }
              >
                {transcript || partial
                  ? [transcript, partial].filter(Boolean).join("\n")
                  : "Transcribed text will appear here"}
              </p>
              <div className="is-flex is-align-items-center mt-1">
                <button
                  type="button"
                  className="button is-small"
                  title="Type the transcript into the focused window"
                  disabled={!transcript || transcript.startsWith("Error:")}
                  onClick={() => this.typeTranscript()}
                >
                  Type
                </button>
                <button
                  type="button"
                  className="button is-small is-light ml-2"
                  title="Discard the transcript"
                  disabled={!transcript && !partial}
                  onClick={() => this.clearTranscript()}
                >
                  Clear
                </button>
              </div>
            </div>
            {typeError && (
              <p className="notification is-warning is-light py-1 px-2 is-size-7 mt-1">
                {typeError}
              </p>
            )}
          </div>

          <DeviceList
            devices={devices}
            selected={selected}
            error={error}
            onToggle={(device) => this.toggleDevice(device)}
          />
        </div>
      </section>
    );
  }
}

export default App;

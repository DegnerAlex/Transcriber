import {Component} from "react";
import {FaCheck, FaCopy} from "react-icons/fa6";
import {writeText} from "@tauri-apps/plugin-clipboard-manager";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {DeviceList} from "./components/DeviceList";
import {LanguagePicker} from "./components/LanguagePicker";
import {ModelPicker} from "./components/ModelPicker";
import {TranscriptChat} from "./components/TranscriptChat";
import {InputToggle} from "./components/InputToggle";
import {BackendBadge} from "./components/BackendBadge";
import {SensitivitySlider} from "./components/SensitivitySlider";
import type {AudioInputDevice, AudioOutputDevice} from "./components/DeviceList";
import {Waveform} from "./components/Waveform";
import "./App.scss";

interface AppState {
    devices: AudioInputDevice[];
    error: string | null;
    selected: AudioInputDevice | null;
    outputDevices: AudioOutputDevice[];
    selectedOutput: string | null;
    monitorError: string | null;
    gain: number;
    language: string;
    /** Model persisted from the previous session, forwarded to ModelPicker
     *  once the settings file has been loaded. */
    savedModel: string | null;
    autoType: boolean;
    windowFocused: boolean;
    backend: string;
    transcriptLines: string[];
    partial: string | null;
    typeError: string | null;
    copied: boolean;
}

interface TranscriptionPayload {
    text: string;
    segments: number;
}

interface ActiveMonitorPayload {
    host: string;
    driver: string | null;
    name: string;
}

class App extends Component<Record<string, never>, AppState> {
    /** Live unlisten functions, keyed by event name (StrictMode remounts can
     *  resolve two listen() promises for the same event — keep only one). */
    private unlistenMap = new Map<string, () => void>();
    /** Set on unmount: late-resolving listener promises must self-detach. */
    private disposed = false;
    /** Monotonic id of the latest start_audio_monitor request. */
    private monitorSeq = 0;

    /** All persisted UI settings, loaded from the Rust side at startup
     *  (settings.json next to transcript.json). Webview localStorage is not
     *  used: in the packaged app its storage for the tauri://localhost
     *  origin does not reliably survive restarts. */
    private settings: Record<string, unknown> = {};

    private loadSetting<T>(key: string, fallback: T): T {
        const value = this.settings[key];
        return value === undefined ? fallback : (value as T);
    }

    private saveSetting(key: string, value: unknown): void {
        this.settings[key] = value;
        invoke("save_settings", {settings: this.settings}).catch(() => {
            // storage unavailable — the in-memory copy still holds
        });
    }

    /** First run of the file-based store: adopt whatever the webview
     *  localStorage still holds (from previous dev-mode sessions). */
    private migrateLegacyLocalStorage(): void {
        try {
            for (let i = 0; i < window.localStorage.length; i++) {
                const key = window.localStorage.key(i);
                if (!key || !key.startsWith("translator.")) continue;
                try {
                    const raw = window.localStorage.getItem(key);
                    if (raw !== null) this.settings[key] = JSON.parse(raw);
                } catch {
                    // malformed entry — skip
                }
            }
        } catch {
            // storage unavailable — nothing to migrate
        }
        if (Object.keys(this.settings).length > 0) {
            invoke("save_settings", {settings: this.settings}).catch(() => {});
        }
    }

    state: AppState = {
        devices: [],
        error: null,
        selected: null,
        outputDevices: [],
        selectedOutput: null,
        monitorError: null,
        gain: 100,
        language: "auto",
        savedModel: null,
        autoType: true,
        windowFocused: false,
        backend: "cpu",
        transcriptLines: [],
        partial: null,
        typeError: null,
        copied: false,
    };

    componentDidMount(): void {
        // StrictMode may simulate unmount+remount on the same instance; the
        // disposed flag must be cleared so listeners re-attach on the remount.
        this.disposed = false;
        this.attachTranscriptionListeners();

        this.refreshDevices();
        // Restore persisted settings (sensitivity, Input toggle, language,
        // model, device) from the Rust side so they survive app restarts.
        // They live in a JSON file next to the transcript: webview
        // localStorage is not reliably persisted in the packaged app.
        const restore = invoke<Record<string, unknown>>("load_settings")
            .then((saved) => {
                this.settings = saved;
                // First run of the file-based store: migrate whatever the
                // dev-mode localStorage still holds.
                if (Object.keys(this.settings).length === 0) {
                    this.migrateLegacyLocalStorage();
                }
            })
            // The transcript itself lives in a file on the Rust side.
            .then(() => invoke<string[]>("load_transcript"))
            .then((saved) => {
                this.setState({
                    transcriptLines:
                        saved.length > 0
                            ? saved
                            : this.loadSetting<string[]>(
                                  "translator.transcriptLines",
                                  [],
                              ),
                    gain: this.loadSetting<number>("translator.gain", 100),
                    autoType: this.loadSetting<boolean>("translator.autoType", true),
                    language: this.loadSetting<string>("translator.language", "auto"),
                    savedModel: this.loadSetting<string | null>(
                        "translator.model",
                        null,
                    ),
                });
            });
        // The restored UI is ready — dismiss the splash screen window and
        // reveal the main window. Failure is harmless (no splash, e.g. after
        // a webview reload in dev).
        restore.finally(() => invoke("close_splashscreen").catch(() => {}));
        // Sync the device selection with the backend: the Rust process keeps
        // the capture monitor running across webview reloads, so the UI must
        // reflect the device it is actually capturing from. Runs after the
        // settings restore — auto-resume reads the saved device.
        // Layout diagnostics: find which element breaks the flex shrink chain.
        window.setTimeout(() => {
            const measure = (sel: string, name: string) => {
                const el = document.querySelector(sel);
                if (!el) {
                    invoke("debug_log", {message: `${name}: not found`}).catch(() => {});
                    return;
                }
                invoke("debug_log", {
                    message: `${name}: h=${Math.round(el.getBoundingClientRect().height)} scrollH=${el.scrollHeight}`,
                }).catch(() => {});
            };
            measure(".app-columns", "app-columns");
            measure(".app-column-left", "column-left");
            measure(".live-panel", "live-panel");
            measure(".transcript-chat", "chat");
            const doc = document.documentElement;
            invoke("debug_log", {
                message: `document: innerH=${window.innerHeight} docScrollH=${doc.scrollHeight} docClientH=${doc.clientHeight} bodyScrollH=${document.body.scrollHeight}`,
            }).catch(() => {});
        }, 800);

        restore
            .then(() => invoke<ActiveMonitorPayload | null>("get_active_monitor"))
            .then((active) => {
                if (active) {
                    // A monitor is already running (webview reload) — sync the
                    // UI and remember the device for future restarts.
                    if (active.host === "pipewire") {
                        this.setState({selectedOutput: active.name});
                    } else {
                        this.setState({
                            selected: {
                                name: active.name,
                                driver: active.driver,
                                manufacturer: null,
                                deviceType: "",
                                interface: "",
                                isDefault: false,
                                defaultConfig: null,
                            },
                        });
                    }
                    this.saveSetting("translator.selectedDevice", {
                        host: active.host,
                        driver: active.driver,
                        name: active.name,
                    });
                    return;
                }
                // No monitor running (full app restart) — auto-resume the
                // device that was selected before the restart.
                const saved = this.loadSetting<{
                    host: string;
                    driver: string | null;
                    name: string;
                } | null>("translator.selectedDevice", null);
                if (!saved) return;
                if (saved.host === "pipewire") {
                    this.setState({selectedOutput: saved.name});
                } else {
                    this.setState({
                        selected: {
                            name: saved.name,
                            driver: saved.driver,
                            manufacturer: null,
                            deviceType: "",
                            interface: "",
                            isDefault: false,
                            defaultConfig: null,
                        },
                    });
                }
            })
            .catch(() => {
            });

        // Track whether the translator window itself has focus: auto-typing is
        // suppressed while it does, so phrases are never typed into this app.
        // Guarded: outside the Tauri webview (plain browser) getCurrentWindow()
        // throws synchronously.
        try {
            const appWindow = getCurrentWindow();
            appWindow
                .isFocused()
                .then((focused) => {
                    if (!this.disposed) this.setState({windowFocused: focused});
                })
                .catch(() => {
                });
            appWindow
                .onFocusChanged((event) => {
                    if (!this.disposed) this.setState({windowFocused: !!event.payload});
                })
                .then((stop) => {
                    if (this.disposed) stop();
                    else this.unlistenMap.set("__windowFocus", stop);
                })
                .catch(() => {
                });
        } catch {
            // Not running inside Tauri — focus suppression unavailable.
        }

        invoke<AudioOutputDevice[]>("list_audio_output_devices")
            .then((outputDevices) => this.setState({outputDevices}))
            .catch(() => {
            });

        invoke<string>("get_transcription_backend")
            .then((backend) => this.setState({backend}))
            .catch(() => {});
        // Push the restored settings to the backend (runs once the file
        // store has been loaded).
        restore
            .then(() => {
                invoke("set_audio_monitor_gain", {
                    gainPercent: this.loadSetting<number>("translator.gain", 100),
                }).catch(() => {
                });
                invoke("set_transcription_language", {
                    language: this.loadSetting<string>("translator.language", "auto"),
                }).catch(() => {
                });
            });
    }

    componentDidUpdate(
        _prevProps: Record<string, never>,
        prevState: AppState,
    ): void {
        // Chat: autoscroll + persistence — must run on every update, before
        // any early return below.
        if (prevState.transcriptLines !== this.state.transcriptLines) {
            this.saveSetting(
                "translator.transcriptLines",
                this.state.transcriptLines,
            );
            const chat = document.querySelector(".transcript-chat");
            const column = document.querySelector(".app-column-left");
            const panel = document.querySelector(".live-panel");
            invoke("debug_log", {
                message: `chat filled: chat h=${chat ? Math.round(chat.getBoundingClientRect().height) : -1} scrollH=${chat ? chat.scrollHeight : -1} | panel h=${panel ? Math.round(panel.getBoundingClientRect().height) : -1} | column h=${column ? Math.round(column.getBoundingClientRect().height) : -1} colScrollH=${column ? column.scrollHeight : -1}`,
            }).catch(() => {});
        }

        // The capture monitor is single: it runs either on the selected input
        // device (ALSA) or on the selected output device (PipeWire monitor).
        const prev = this.monitorRequest(prevState);
        const next = this.monitorRequest(this.state);
        if (prev?.key === next?.key) return;

        if (next) {
            if (next.host === "alsa") {
                // Each freshly selected input device starts at unity gain.
                this.setState({gain: 100});
            }
            const seq = ++this.monitorSeq;
            invoke("start_audio_monitor", {
                host: next.host,
                driver: next.driver,
                name: next.name,
            })
                .then(() => {
                    if (seq === this.monitorSeq) this.setState({monitorError: null});
                })
                .catch((e) => {
                    if (seq === this.monitorSeq) {
                        this.setState({monitorError: String(e)});
                    }
                });
        } else {
            ++this.monitorSeq;
            invoke("stop_audio_monitor").catch(() => {
            });
        }
    }

    /** What the capture monitor should currently run: the selected input
     *  device via ALSA, or the selected output device via PipeWire monitor
     *  capture. Null means the monitor is stopped. */
    private monitorRequest(state: AppState): {
        host: string;
        driver: string | null;
        name: string;
        key: string;
    } | null {
        if (state.selected) {
            return {
                host: "alsa",
                driver: state.selected.driver,
                name: state.selected.name,
                key: `alsa:${state.selected.name}·${state.selected.driver ?? ""}`,
            };
        }
        if (state.selectedOutput) {
            return {
                host: "pipewire",
                driver: null,
                name: state.selectedOutput,
                key: `pw:${state.selectedOutput}`,
            };
        }
        return null;
    }

    componentWillUnmount(): void {
        this.disposed = true;
        this.unlistenMap.forEach((stop) => stop());
        this.unlistenMap.clear();
        if (this.state.selected) {
            invoke("stop_audio_monitor").catch(() => {
            });
        }
    }

    private attachTranscriptionListeners(): void {
        // Automatic transcription results arrive as events from the Rust VAD/
        // whisper pipeline; each finalized utterance is appended on its own line.
        // StrictMode's mount/unmount/remount cycle can resolve two listen()
        // promises for the same event: the first one to resolve wins, later
        // duplicates detach themselves immediately.
        const register = (event: string, stop: () => void) => {
            if (this.disposed) {
                stop();
                return;
            }
            const existing = this.unlistenMap.get(event);
            if (existing) {
                stop();
                return;
            }
            this.unlistenMap.set(event, stop);
        };

        listen<TranscriptionPayload>("transcription", (event) => {
            const text = event.payload.text.trim();
            invoke("debug_log", {
                message: `transcription event: "${text.slice(0, 40)}"`,
            }).catch(() => {
            });
            this.setState({partial: null});
            if (!text) return;
            this.setState((state) => {
                const transcriptLines = [text, ...state.transcriptLines];
                invoke("save_transcript", {lines: transcriptLines}).catch(
                    () => {},
                );
                return {transcriptLines};
            });
            // Auto-type into the currently focused application, as long as it is
            // not this app itself (typing into our own window would be lost).
            if (this.state.autoType && !this.state.windowFocused) {
                invoke("type_text", {text}).catch((e) =>
                    this.setState({typeError: String(e)}),
                );
            }
        }).then((stop) => register("transcription", stop));

        listen<TranscriptionPayload>("transcription-partial", (event) => {
            this.setState({partial: event.payload.text.trim() || null});
        }).then((stop) => register("transcription-partial", stop));

        listen<string>("transcription-error", (event) => {
            this.setState({typeError: String(event.payload)});
        }).then((stop) => register("transcription-error", stop));
    }

    private async refreshDevices(): Promise<void> {
        try {
            const devices = await invoke<AudioInputDevice[]>(
                "list_audio_input_devices",
            );
            this.setState({devices, error: null});
        } catch (e) {
            this.setState({error: String(e)});
        }
    }

    /** Clicking the selected device again stops monitoring it. Selecting an
     *  input device also deselects the output one (one monitor at a time). */
    private toggleDevice = (device: AudioInputDevice): void => {
        const same =
            this.state.selected !== null &&
            this.state.selected.name === device.name &&
            this.state.selected.driver === device.driver;
        const selected = same ? null : device;
        this.setState({selected, selectedOutput: null});
        this.saveSetting(
            "translator.selectedDevice",
            selected
                ? {host: "alsa", driver: selected.driver, name: selected.name}
                : null,
        );
    };

    /** Clicking the selected output device again stops monitoring it. */
    private toggleOutputDevice = (device: AudioOutputDevice): void => {
        const same = this.state.selectedOutput === device.name;
        const selectedOutput = same ? null : device.name;
        this.setState({selectedOutput, selected: null});
        this.saveSetting(
            "translator.selectedDevice",
            selectedOutput
                ? {host: "pipewire", driver: null, name: selectedOutput}
                : null,
        );
    };

    private changeGain = (value: number): void => {
        this.setState({gain: value});
        this.saveSetting("translator.gain", value);
        invoke("set_audio_monitor_gain", {gainPercent: value}).catch(() => {
        });
    };

    private changeLanguage = (value: string): void => {
        this.setState({language: value});
        this.saveSetting("translator.language", value);
        invoke("set_transcription_language", {language: value}).catch(() => {
        });
    };

    /** Persist the model choice (the switch itself is done by ModelPicker). */
    private selectModel = (name: string): void => {
        this.saveSetting("translator.model", name);
    };

    private toggleAutoType = (): void => {
        const autoType = !this.state.autoType;
        this.setState({autoType});
        this.saveSetting("translator.autoType", autoType);
    };

    private copyTranscript = async (): Promise<void> => {
        const lines = this.state.transcriptLines;
        if (lines.length === 0) return;
        // The chat shows newest first; the copied text is chronological
        // (oldest on top, newest at the bottom).
        const text = [...lines].reverse().join("\n");
        try {
            // navigator.clipboard throws NotAllowedError inside WKWebView —
            // the native clipboard plugin is the reliable path in Tauri.
            await writeText(text);
        } catch {
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                // Last resort: legacy execCommand fallback (WebKit honors it
                // without clipboard permissions).
                const area = document.createElement("textarea");
                area.value = text;
                area.style.position = "fixed";
                area.style.opacity = "0";
                document.body.appendChild(area);
                area.focus();
                area.select();
                document.execCommand("copy");
                area.remove();
            }
        }
        this.setState({copied: true});
        window.setTimeout(() => {
            if (!this.disposed) this.setState({copied: false});
        }, 2000);
    };

    /** Remove one finalized message; the transcript file is updated right
     *  away (componentDidUpdate only persists to the settings store). */
    private deleteLine = (index: number): void => {
        const transcriptLines = this.state.transcriptLines.filter(
            (_, i) => i !== index,
        );
        this.setState({transcriptLines});
        invoke("save_transcript", {lines: transcriptLines}).catch(() => {});
    };

    private clearTranscript = (): void => {
        this.setState({transcriptLines: [], partial: null, typeError: null});
        invoke("save_transcript", {lines: []}).catch(() => {});
    };

    render() {
        const {
            devices,
            error,
            selected,
            outputDevices,
            selectedOutput,
            monitorError,
            gain,
            language,
            savedModel,
            autoType,
            backend,
            transcriptLines,
            partial,
            typeError,
            copied,
        } = this.state;

        return (
            <section className="section is-flex-grow-1 compact">
                <div className="container is-max-desktop">
                    <div className="app-columns">
                        <div className="app-column-left">
                    <div className="live-panel">
                        <div className="is-size-7 has-text-weight-semibold mb-1">
                            {selected
                                ? `Live: ${selected.name}`
                                : selectedOutput
                                    ? `Live (output): ${selectedOutput}`
                                    : "Live input — select a device below"}
                        </div>
                        {monitorError && (
                            <p className="notification is-warning is-light py-1 px-2 is-size-7">
                                {monitorError}
                            </p>
                        )}
                        <Waveform active={selected !== null || selectedOutput !== null}/>
                        <SensitivitySlider
                            value={gain}
                            disabled={(selected === null && selectedOutput === null) || !!monitorError}
                            onChange={this.changeGain}
                        />
                        <div className="is-flex is-align-items-center flex-wrap mt-2">
                            <LanguagePicker
                                language={language}
                                onChange={this.changeLanguage}
                            />
                            <ModelPicker
                                savedModel={savedModel}
                                onSelect={this.selectModel}
                            />
                            <BackendBadge backend={backend}/>
                        </div>
                    <div className="is-flex is-justify-content-space-between is-align-items-center mb-1 mt-3">
                        <div className="is-size-7 has-text-weight-semibold">Transcript</div>
                        <div className="is-flex is-align-items-center">
                            <button
                                type="button"
                                className="button is-small is-light mr-2"
                                title="Discard the transcript"
                                disabled={transcriptLines.length === 0 && !partial}
                                onClick={() => this.clearTranscript()}
                            >
                                Clear
                            </button>
                            <InputToggle
                                on={autoType}
                                onToggle={() => this.toggleAutoType()}
                            />
                            <button
                                type="button"
                                className="icon-button"
                                title="Copy all transcribed text"
                                disabled={transcriptLines.length === 0}
                                onClick={() => this.copyTranscript()}
                            >
                                {copied ? <FaCheck/> : <FaCopy/>}
                            </button>
                        </div>
                        {typeError && (
                            <div className="has-text-danger is-size-7">{typeError}</div>
                        )}
                    </div>
                    <TranscriptChat
                        lines={transcriptLines}
                        partial={partial}
                        onDelete={this.deleteLine}
                    />
                    </div>
                    </div>

                    <div className="app-column-right">
                    <DeviceList
                        devices={devices}
                        selected={selected}
                        error={error}
                        onToggle={(device) => this.toggleDevice(device)}
                        onRefresh={() => this.refreshDevices()}
                        outputs={outputDevices}
                        selectedOutput={selectedOutput}
                        onToggleOutput={(device) => this.toggleOutputDevice(device)}
                    />
                    </div>
                </div>
            </div>
            </section>
        );
    }
}

export default App;

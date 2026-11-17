import {Component, createRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {DeviceList} from "./components/DeviceList";
import type {AudioInputDevice, AudioOutputDevice} from "./components/DeviceList";
import {Waveform} from "./components/Waveform";
import "./App.css";

interface AppState {
    devices: AudioInputDevice[];
    error: string | null;
    selected: AudioInputDevice | null;
    outputDevices: AudioOutputDevice[];
    selectedOutput: string | null;
    monitorError: string | null;
    gain: number;
    language: string;
    languages: string[];
    languagesError: string | null;
    languagesOpen: boolean;
    models: { name: string; active: boolean }[];
    modelsOpen: boolean;
    modelSwitching: boolean;
    modelsError: string | null;
    autoType: boolean;
    windowFocused: boolean;
    transcriptLines: string[];
    partial: string | null;
    typeError: string | null;
}

interface TranscriptionPayload {
    text: string;
    segments: number;
}

class App extends Component<Record<string, never>, AppState> {
    /** Live unlisten functions, keyed by event name (StrictMode remounts can
     *  resolve two listen() promises for the same event — keep only one). */
    private unlistenMap = new Map<string, () => void>();
    /** Scroll anchor for the transcript chat. */
    private chatRef = createRef<HTMLDivElement>();
    /** Set on unmount: late-resolving listener promises must self-detach. */
    private disposed = false;
    /** Monotonic id of the latest start_audio_monitor request. */
    private monitorSeq = 0;

    private loadSetting<T>(key: string, fallback: T): T {
        try {
            const raw = window.localStorage.getItem(key);
            return raw === null ? fallback : (JSON.parse(raw) as T);
        } catch {
            return fallback;
        }
    }

    private saveSetting(key: string, value: unknown): void {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // storage unavailable — ignore
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
        languages: [],
        languagesError: null,
        languagesOpen: false,
        models: [],
        modelsOpen: false,
        modelSwitching: false,
        modelsError: null,
        autoType: true,
        windowFocused: false,
        transcriptLines: [],
        partial: null,
        typeError: null,
    };

    componentDidMount(): void {
        // StrictMode may simulate unmount+remount on the same instance; the
        // disposed flag must be cleared so listeners re-attach on the remount.
        this.disposed = false;
        this.attachTranscriptionListeners();

        // Restore persisted settings (sensitivity, Insert toggle, language,
        // model) so they survive app restarts.
        const gain = this.loadSetting<number>("translator.gain", 100);
        const autoType = this.loadSetting<boolean>("translator.autoType", true);
        const language = this.loadSetting<string>("translator.language", "auto");
        const model = this.loadSetting<string | null>("translator.model", null);
        this.setState({gain, autoType, language});

        this.refreshDevices();

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

        invoke<string[]>("list_transcription_languages")
            .then((languages) => {
                invoke("debug_log", {
                    message: `languages fetched: ${languages.length}`,
                }).catch(() => {
                });
                this.setState({languages});
            })
            .catch((e) => {
                invoke("debug_log", {message: `languages error: ${e}`}).catch(
                    () => {
                    },
                );
                this.setState({languagesError: String(e)});
            });
        this.refreshModels();

        // Push the restored settings to the backend.
        invoke("set_audio_monitor_gain", {gainPercent: gain}).catch(() => {
        });
        invoke("set_transcription_language", {language}).catch(() => {
        });
        if (model) {
            invoke("select_transcription_model", {name: model})
                .then(() => this.refreshModels())
                .catch(() => {
                });
        }
    }

    componentDidUpdate(
        _prevProps: Record<string, never>,
        prevState: AppState,
    ): void {
        // The capture monitor is single: it runs either on the selected input
        // device (ALSA) or on the selected output device (PipeWire monitor).
        const prev = this.monitorRequest(prevState);
        const next = this.monitorRequest(this.state);
        if (prev?.key === next?.key) return;

        if (
            prevState.transcriptLines !== this.state.transcriptLines ||
            prevState.partial !== this.state.partial
        ) {
            const chat = this.chatRef.current;
            if (chat) chat.scrollTop = chat.scrollHeight;
        }

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
            this.setState((state) => ({
                transcriptLines: [...state.transcriptLines, text],
            }));
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
        this.setState((state) =>
            state.selected !== null &&
            state.selected.name === device.name &&
            state.selected.driver === device.driver
                ? {selected: null, selectedOutput: null}
                : {selected: device, selectedOutput: null},
        );
    };

    /** Clicking the selected output device again stops monitoring it. */
    private toggleOutputDevice = (device: AudioOutputDevice): void => {
        this.setState((state) =>
            state.selectedOutput === device.name
                ? {selectedOutput: null, selected: null}
                : {selectedOutput: device.name, selected: null},
        );
    };

    private changeGain = (value: number): void => {
        this.setState({gain: value});
        this.saveSetting("translator.gain", value);
        invoke("set_audio_monitor_gain", {gainPercent: value}).catch(() => {
        });
    };

    private changeLanguage = (value: string): void => {
        this.setState({language: value, languagesOpen: false});
        this.saveSetting("translator.language", value);
        invoke("set_transcription_language", {language: value}).catch(() => {
        });
    };

    private refreshModels = (): void => {
        invoke<{ name: string; active: boolean }[]>("list_available_models")
            .then((models) => this.setState({models, modelsError: null}))
            .catch((e) => this.setState({modelsError: String(e)}));
    };

    private selectModel = (name: string): void => {
        if (this.state.modelSwitching) return;
        const current = this.state.models.find((m) => m.active);
        if (current && current.name === name) {
            // Already loaded — just collapse the list.
            this.setState({modelsOpen: false});
            return;
        }
        this.setState({modelSwitching: true});
        this.saveSetting("translator.model", name);
        invoke("select_transcription_model", {name})
            .then(() => {
                this.refreshModels();
                this.setState({modelsOpen: false});
            })
            .catch((e) => this.setState({modelsError: String(e)}))
            .finally(() => this.setState({modelSwitching: false}));
    };

    private toggleAutoType = (): void => {
        const autoType = !this.state.autoType;
        this.setState({autoType});
        this.saveSetting("translator.autoType", autoType);
    };

    private clearTranscript = (): void => {
        this.setState({transcriptLines: [], partial: null, typeError: null});
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
            languages,
            languagesError,
            languagesOpen,
            models,
            modelsOpen,
            modelSwitching,
            modelsError,
            autoType,
            transcriptLines,
            partial,
            typeError,
        } = this.state;

        return (
            <section className="section is-flex-grow-1 compact">
                <div className="container is-max-desktop">
                    <div className="app-columns">
                        <div className="app-column-left">
                    <div className="box p-3 live-panel">
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
                        <div className="is-flex is-align-items-center mt-1">
                            <span className="is-size-7 has-text-grey mr-2">Sensitivity</span>
                            <input
                                type="range"
                                min={0}
                                max={400}
                                step={5}
                                value={gain}
                                disabled={(selected === null && selectedOutput === null) || !!monitorError}
                                onChange={(e) => this.changeGain(Number(e.currentTarget.value))}
                                className="gain-slider mr-2"
                            />
                            <span className="is-size-7 gain-value">{Math.round(gain)}%</span>
                        </div>
                        <div className="is-flex is-align-items-center mt-2">
                            <span className="is-size-7 has-text-grey mr-2">Model</span>
                            {modelsError && (
                                <span className="is-size-7 has-text-danger">{modelsError}</span>
                            )}
                            <button
                                type="button"
                                title="Switch transcription model"
                                className="button is-small is-light"
                                onClick={() =>
                                    this.setState((state) => ({modelsOpen: !state.modelsOpen}))
                                }
                            >
                                {models.find((m) => m.active)?.name.replace(/^ggml-/, "").replace(/\.bin$/, "") ||
                                    "…"}
                            </button>
                        </div>
                        {modelsOpen && (
                            <div className="chip-row mt-1">
                                {models.map((m) => (
                                    <button
                                        key={m.name}
                                        type="button"
                                        disabled={modelSwitching}
                                        className={
                                            "button is-small" + (m.active ? " is-info" : " is-light")
                                        }
                                        onClick={() => this.selectModel(m.name)}
                                    >
                                        {m.name.replace(/^ggml-/, "").replace(/\.bin$/, "")}
                                    </button>
                                ))}
                            </div>
                        )}
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
                    </div>
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

                    <div className="app-column-right">
                        <div className="box p-3 transcript-box">
                            <div className="is-size-7 has-text-weight-semibold mb-1">Transcript</div>
                            <div className="transcript-chat" ref={this.chatRef}>
                                {transcriptLines.length === 0 && !partial && (
                                    <div className="chat-empty">Transcribed text will appear here</div>
                                )}
                                {transcriptLines.map((line, i) => (
                                    <div key={i} className="chat-message">{line}</div>
                                ))}
                                {partial && (
                                    <div className="chat-message chat-partial">{partial}</div>
                                )}
                            </div>
                            <div className="is-flex is-align-items-center mt-1">
                                <button
                                    type="button"
                                    className="button is-small is-light"
                                    title="Discard the transcript"
                                    disabled={transcriptLines.length === 0 && !partial}
                                    onClick={() => this.clearTranscript()}
                                >
                                    Clear
                                </button>
                                <button
                                    type="button"
                                    className={
                                        "button is-small" +
                                        (autoType ? " is-success" : " is-light")
                                    }
                                    style={{marginLeft: "auto"}}
                                    title={
                                        autoType
                                            ? "Insert is ON — each phrase is typed into the focused application. Click to turn off."
                                            : "Insert is OFF — click to type each phrase into the focused application automatically."
                                    }
                                    onClick={() => this.toggleAutoType()}
                                >
                                    Insert: {autoType ? "on" : "off"}
                                </button>
                            </div>
                            {typeError && (
                                <p className="notification is-warning is-light py-1 px-2 is-size-7 mt-1">
                                    {typeError}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            </section>
        );
    }
}

export default App;

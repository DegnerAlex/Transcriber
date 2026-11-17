import {Component, createRef} from "react";
import {FaCheck, FaCopy} from "react-icons/fa6";
import {writeText} from "@tauri-apps/plugin-clipboard-manager";
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

interface ActiveMonitorPayload {
    host: string;
    driver: string | null;
    name: string;
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

        // Restore persisted settings (sensitivity, Input toggle, language,
        // model) so they survive app restarts.
        const gain = this.loadSetting<number>("translator.gain", 100);
        const autoType = this.loadSetting<boolean>("translator.autoType", true);
        const language = this.loadSetting<string>("translator.language", "auto");
        const model = this.loadSetting<string | null>("translator.model", null);
        // The transcript itself lives in a file on the Rust side (mounted
        // volume) — webview localStorage is wiped on container recreation.
        invoke<string[]>("load_transcript")
            .then((saved) => {
                this.setState({
                    transcriptLines: saved,
                    ...(saved.length === 0
                        ? {
                              transcriptLines: this.loadSetting<string[]>(
                                  "translator.transcriptLines",
                                  [],
                              ),
                          }
                        : {}),
                });
            })
            .catch(() => {
                this.setState({
                    transcriptLines: this.loadSetting<string[]>(
                        "translator.transcriptLines",
                        [],
                    ),
                });
            });
        this.setState({
            gain,
            autoType,
            language,
        });

        this.refreshDevices();
        // Sync the device selection with the backend: the Rust process keeps
        // the capture monitor running across webview reloads, so the UI must
        // reflect the device it is actually capturing from.
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

        invoke<ActiveMonitorPayload | null>("get_active_monitor")
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
        // Chat: autoscroll + persistence — must run on every update, before
        // any early return below.
        if (
            prevState.transcriptLines !== this.state.transcriptLines ||
            prevState.partial !== this.state.partial
        ) {
            const chat = this.chatRef.current;
            if (chat) chat.scrollTop = 0;
            if (prevState.transcriptLines !== this.state.transcriptLines) {
                this.saveSetting(
                    "translator.transcriptLines",
                    this.state.transcriptLines,
                );
                const column = document.querySelector(".app-column-left");
                const panel = document.querySelector(".live-panel");
                invoke("debug_log", {
                    message: `chat filled: chat h=${Math.round(chat.getBoundingClientRect().height)} scrollH=${chat.scrollHeight} | panel h=${panel ? Math.round(panel.getBoundingClientRect().height) : -1} | column h=${column ? Math.round(column.getBoundingClientRect().height) : -1} colScrollH=${column ? column.scrollHeight : -1}`,
                }).catch(() => {});
            }
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
                        <div className="is-flex is-align-items-center flex-wrap mt-2">
                            <span className="is-size-7 has-text-grey mr-2">Language</span>
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
                            <span className="is-size-7 has-text-grey ml-2 mr-2">Model</span>
                            <button
                                type="button"
                                title="Switch transcription model"
                                className="button is-small is-light"
                                onClick={() =>
                                    this.setState((state) => ({modelsOpen: !state.modelsOpen}))
                                }
                            >
                                {models.find((m) => m.active)?.name.replace(/^ggml-/, "").replace(/\.bin$/, "") ||
                                    "\u2026"}
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
                            <button
                                type="button"
                                className={
                                    "button is-small mr-2" +
                                    (autoType ? " is-success" : " is-light")
                                }
                                title={
                                    autoType
                                        ? "Input is ON — each phrase is typed into the focused application. Click to turn off."
                                        : "Input is OFF — click to type each phrase into the focused application automatically."
                                }
                                onClick={() => this.toggleAutoType()}
                            >
                                Input: {autoType ? "on" : "off"}
                            </button>
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
                    </div>
                    <div className="transcript-chat" ref={this.chatRef}>
                        {transcriptLines.length === 0 && !partial && (
                            <div className="chat-empty">Transcribed text will appear here</div>
                        )}
                        {partial && (
                            <div className="chat-message chat-partial">{partial}</div>
                        )}
                        {transcriptLines.map((line, i) => (
                            <div key={i} className="chat-message">{line}</div>
                        ))}
                    </div>
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

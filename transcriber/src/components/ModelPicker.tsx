// Copyright 2026 Alex Degner (alex@ergofox.me)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Component, createRef} from "preact/compat";
import {invoke} from "@tauri-apps/api/core";

interface ModelPickerProps {
    /** Model persisted from the previous session, delivered once the
     *  settings store has loaded. Applied exactly once; null = keep the
     *  engine default. */
    savedModel: string | null;
    /** Called with the chosen model name (persisted by the parent). */
    onSelect: (name: string) => void;
}

interface ModelPickerState {
    models: { name: string; active: boolean }[];
    open: boolean;
    switching: boolean;
    error: string | null;
    /** Viewport coordinates for the fixed-position popover. */
    pos: { left: number; top: number };
}

/** Transcription model selector: a chip button that opens a popover with
 *  the ggml models present on disk (closes on any click outside). Owns the
 *  model list fetching and the switch-in-progress state; the persistence
 *  of the choice is delegated to the parent via onSelect. */
export class ModelPicker extends Component<ModelPickerProps, ModelPickerState> {
    state: ModelPickerState = {models: [], open: false, switching: false, error: null, pos: {left: 0, top: 0}};

    /** The popover is fixed-positioned (it must not be clipped by the
     *  column's overflow: hidden), so its coordinates come from the
     *  button's viewport rect at the moment of opening. */
    private buttonRef = createRef<HTMLButtonElement>();

    /** Anchor of the button and the popover: clicks outside of it close. */
    private wrapRef = createRef<HTMLSpanElement>();

    /** The saved model this instance has already applied (StrictMode
     *  remounts must not re-run the switch). */
    private appliedSaved: string | null = null;

    componentDidMount(): void {
        this.refresh();
        this.applySaved();
        document.addEventListener("mousedown", this.handleOutside);
    }

    componentDidUpdate(prevProps: ModelPickerProps): void {
        // The saved model arrives asynchronously (settings file load).
        if (prevProps.savedModel === null && this.props.savedModel !== null) {
            this.applySaved();
        }
    }

    componentWillUnmount(): void {
        document.removeEventListener("mousedown", this.handleOutside);
    }

    private handleOutside = (event: MouseEvent): void => {
        const wrap = this.wrapRef.current;
        if (this.state.open && wrap && !wrap.contains(event.target as Node)) {
            this.setState({open: false});
        }
    };

    private toggle = (): void => {
        if (this.state.open) {
            this.setState({open: false});
            return;
        }
        const button = this.buttonRef.current;
        const pos = button
            ? {
                  left: Math.max(
                      8,
                      Math.min(
                          button.getBoundingClientRect().left,
                          window.innerWidth - 380 - 8,
                      ),
                  ),
                  top: button.getBoundingClientRect().bottom + 4,
              }
            : {left: 0, top: 0};
        this.setState({open: true, pos});
    };

    /** Re-read the available models and which one is active. */
    refresh(): void {
        invoke<{ name: string; active: boolean }[]>("list_available_models")
            .then((models) => this.setState({models, error: null}))
            .catch((e) => this.setState({error: String(e)}));
    }

    /** Switch to the model persisted from the previous session. */
    private applySaved(): void {
        const saved = this.props.savedModel;
        if (!saved || this.appliedSaved === saved) return;
        this.appliedSaved = saved;
        invoke("select_transcription_model", {name: saved})
            .then(() => this.refresh())
            .catch(() => {
                // Engine keeps the default model — the list stays honest.
            });
    }

    private select = (name: string): void => {
        if (this.state.switching) return;
        const current = this.state.models.find((m) => m.active);
        if (current && current.name === name) {
            // Already loaded — just collapse the list.
            this.setState({open: false});
            return;
        }
        this.setState({switching: true});
        this.props.onSelect(name);
        invoke("select_transcription_model", {name})
            .then(() => {
                this.refresh();
                this.setState({open: false});
            })
            .catch((e) => this.setState({error: String(e)}))
            .finally(() => this.setState({switching: false}));
    };

    render() {
        const {open, models, switching, error, pos} = this.state;
        return (
            <>
                <span className="is-size-7 has-text-grey ml-2 mr-2">Model</span>
                {error && (
                    <span className="is-size-7 has-text-danger">{error}</span>
                )}
                <span className="picker-wrap" ref={this.wrapRef}>
                    <button
                        ref={this.buttonRef}
                        type="button"
                        title="Switch transcription model"
                        className="button is-small is-light"
                        onClick={this.toggle}
                    >
                        {models
                            .find((m) => m.active)
                            ?.name.replace(/^ggml-/, "")
                            .replace(/\.bin$/, "") || "\u2026"}
                    </button>
                    {open && (
                        <span
                            className="picker-popover model-list"
                            style={{
                                position: "fixed",
                                left: pos.left,
                                top: pos.top,
                                width: "max-content",
                                maxWidth: 560,
                            }}
                        >
                            {models.map((m) => (
                                <button
                                    key={m.name}
                                    type="button"
                                    title={
                                        m.active
                                            ? "Active model"
                                            : "Load the " +
                                              m.name.replace(/^ggml-/, "").replace(/\.bin$/, "") +
                                              " model"
                                    }
                                    disabled={switching}
                                    className={
                                        "button is-small" + (m.active ? " is-info" : " is-light")
                                    }
                                    onClick={() => this.select(m.name)}
                                >
                                    {m.name.replace(/^ggml-/, "").replace(/\.bin$/, "")}
                                </button>
                            ))}
                        </span>
                    )}
                </span>
            </>
        );
    }
}

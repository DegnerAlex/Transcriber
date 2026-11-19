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

interface LanguagePickerProps {
    /** Currently selected transcription language ("auto" or a code). */
    language: string;
    /** Called with the chosen language value. */
    onChange: (language: string) => void;
}

interface LanguagePickerState {
    languages: string[];
    error: string | null;
    open: boolean;
    /** Viewport coordinates for the fixed-position popover. */
    pos: { left: number; top: number };
}

/** Width of the language popover: 10 comfortable columns for the ~100
 *  codes, clamped to the window when opened near the right edge. */
const POPOVER_WIDTH = 540;

/** Transcription language selector: a chip button that opens a popover with
 *  the languages supported by the loaded whisper model. The popover closes
 *  on any click outside of it. The selection itself is owned by the parent
 *  (persisted there); this component only fetches the available languages
 *  and manages its open/error state. */
export class LanguagePicker extends Component<LanguagePickerProps, LanguagePickerState> {
    state: LanguagePickerState = {languages: [], error: null, open: false, pos: {left: 0, top: 0}};

    /** The popover is fixed-positioned (it must not be clipped by the
     *  column's overflow: hidden), so its coordinates come from the
     *  button's viewport rect at the moment of opening. */
    private buttonRef = createRef<HTMLButtonElement>();

    /** Anchor of the button and the popover: clicks outside of it close. */
    private wrapRef = createRef<HTMLSpanElement>();

    componentDidMount(): void {
        invoke<string[]>("list_transcription_languages")
            .then((languages) => this.setState({languages, error: null}))
            .catch((e) => this.setState({error: String(e)}));
        document.addEventListener("mousedown", this.handleOutside);
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
                          window.innerWidth - POPOVER_WIDTH - 8,
                      ),
                  ),
                  top: button.getBoundingClientRect().bottom + 4,
              }
            : {left: 0, top: 0};
        this.setState({open: true, pos});
    };

    render() {
        const {language, onChange} = this.props;
        const {languages, error, open, pos} = this.state;
        return (
            <>
                <span className="is-size-7 has-text-grey mr-2">Language</span>
                {error && (
                    <span className="is-size-7 has-text-danger">{error}</span>
                )}
                <span className="picker-wrap" ref={this.wrapRef}>
                    <button
                        ref={this.buttonRef}
                        type="button"
                        title="Change transcription language"
                        className={
                            "button is-small" + (language === "auto" ? " is-info" : " is-light")
                        }
                        onClick={this.toggle}
                    >
                        {language}
                    </button>
                    {open && (
                        <span
                            className="picker-popover language-grid"
                            style={{
                                position: "fixed",
                                left: pos.left,
                                top: pos.top,
                                width: POPOVER_WIDTH,
                                maxWidth: "none",
                            }}
                        >
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
                                    onClick={() => {
                                        this.setState({open: false});
                                        onChange(value);
                                    }}
                                >
                                    {label}
                                </button>
                            ))}
                        </span>
                    )}
                </span>
            </>
        );
    }
}

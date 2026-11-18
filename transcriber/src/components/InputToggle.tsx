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

import {Component} from "react";

interface InputToggleProps {
    /** Whether automatic insertion into the focused application is on. */
    on: boolean;
    /** Called when the user clicks the toggle. */
    onToggle: () => void;
}

/** The "Input: on/off" button in the transcript header. When on, each
 *  finalized utterance is typed into the currently focused application
 *  (except this app itself); when off, the text only lands in the chat. */
export class InputToggle extends Component<InputToggleProps> {
    render() {
        const {on, onToggle} = this.props;
        return (
            <button
                type="button"
                className={
                    "button is-small mr-2" +
                    (on ? " is-success" : " is-light")
                }
                title={
                    on
                        ? "Input is ON — each phrase is typed into the focused application. Click to turn off."
                        : "Input is OFF — click to type each phrase into the focused application automatically."
                }
                onClick={onToggle}
            >
                Input: {on ? "on" : "off"}
            </button>
        );
    }
}

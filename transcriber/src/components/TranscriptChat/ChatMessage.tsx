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

import {Component} from "preact/compat";
import {FaXmark} from "react-icons/fa6";

interface ChatMessageProps {
    /** Message text. */
    text: string;
    /** Called when the user clicks the delete button. */
    onDelete: () => void;
}

/** A single finalized transcript message with a hover-revealed delete
 *  button. Purely presentational: removal is handled by the parent. */
export class ChatMessage extends Component<ChatMessageProps> {
    render() {
        const {text, onDelete} = this.props;
        return (
            <div className="chat-message">
                <span className="chat-text">{text}</span>
                <button
                    type="button"
                    className="chat-delete"
                    title="Delete this message"
                    onClick={onDelete}
                >
                    <FaXmark/>
                </button>
            </div>
        );
    }
}

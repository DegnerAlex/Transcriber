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

import {Component, createRef} from "react";
import {ChatMessage} from "./ChatMessage";

interface TranscriptChatProps {
    /** Finalized utterances, newest first. */
    lines: string[];
    /** In-progress utterance, shown as a highlighted draft. */
    partial: string | null;
    /** Removes one finalized message by its position (newest first). */
    onDelete: (index: number) => void;
}

/** The transcript chat: newest message on top, partial drafts are de-emphasized.
 *  Every finalized message has a delete button (visible on hover). It is the
 *  only scrollable element of the left column; on every new message the scroll
 *  is anchored back to the top, where the newest entry is. */
export class TranscriptChat extends Component<TranscriptChatProps> {
    private chatRef = createRef<HTMLDivElement>();

    componentDidUpdate(prevProps: TranscriptChatProps): void {
        if (
            prevProps.lines !== this.props.lines ||
            prevProps.partial !== this.props.partial
        ) {
            const chat = this.chatRef.current;
            if (chat) chat.scrollTop = 0;
        }
    }

    render() {
        const {lines, partial, onDelete} = this.props;
        return (
            <div className="transcript-chat" ref={this.chatRef}>
                {lines.length === 0 && !partial && (
                    <div className="chat-empty">
                        Transcribed text will appear here
                    </div>
                )}
                {partial && (
                    <div className="chat-message chat-partial">{partial}</div>
                )}
                {lines.map((line, i) => (
                    <ChatMessage
                        key={i}
                        text={line}
                        onDelete={() => onDelete(i)}
                    />
                ))}
            </div>
        );
    }
}

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

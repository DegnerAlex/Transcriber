import {Component} from "react";
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

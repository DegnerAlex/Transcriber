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

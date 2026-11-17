import {Component} from "react";

interface SensitivitySliderProps {
    /** Gain percentage (0–400). */
    value: number;
    /** Disabled while no capture device is running. */
    disabled: boolean;
    /** Called with the new percentage while dragging. */
    onChange: (value: number) => void;
}

/** The sensitivity (gain) slider of the live panel. The value is owned and
 *  persisted by the parent; this component renders the label, the range
 *  input and the percentage readout. */
export class SensitivitySlider extends Component<SensitivitySliderProps> {
    render() {
        const {value, disabled, onChange} = this.props;
        return (
            <div className="is-flex is-align-items-center mt-1">
                <span className="is-size-7 has-text-grey mr-2">Sensitivity</span>
                <input
                    type="range"
                    min={0}
                    max={400}
                    step={5}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(Number(e.currentTarget.value))}
                    className="gain-slider mr-2"
                />
                <span className="is-size-7 gain-value">{Math.round(value)}%</span>
            </div>
        );
    }
}

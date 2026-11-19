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

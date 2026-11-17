import { Component } from "react";

interface AudioInputConfig {
  channels: number;
  sampleRate: number;
  sampleFormat: string;
}

export interface AudioInputDevice {
  name: string;
  driver: string | null;
  manufacturer: string | null;
  deviceType: string;
  interface: string;
  isDefault: boolean;
  defaultConfig: AudioInputConfig | null;
}

export interface AudioOutputDevice {
  name: string;
  deviceType: string;
  interface: string;
  isDefault: boolean;
}

interface DeviceListProps {
  devices: AudioInputDevice[];
  selected: AudioInputDevice | null;
  error: string | null;
  /** Called when the user clicks a device row (toggle selection). */
  onToggle: (device: AudioInputDevice) => void;
  /** Re-enumerate the device lists. */
  onRefresh: () => void;
  /** Output devices (sinks) that can be captured for transcription. */
  outputs: AudioOutputDevice[];
  selectedOutput: string | null;
  onToggleOutput: (device: AudioOutputDevice) => void;
}

/** The list of audio input devices; clicking a row toggles its selection. */
export class DeviceList extends Component<DeviceListProps> {
  render() {
    const {
      devices,
      selected,
      error,
      onToggle,
      onRefresh,
      outputs,
      selectedOutput,
      onToggleOutput,
    } = this.props;

    return (
      <div className="devices-section">
        <div className="level is-mobile mb-1">
          <div className="level-left">
            <span className="has-text-weight-semibold is-size-6">Audio Input</span>
          </div>
          <div className="level-right">
            <button
              type="button"
              className="button is-small refresh-button"
              onClick={onRefresh}
            >
              Refresh
            </button>
          </div>
        </div>
        {error && (
          <p className="notification is-danger is-light">
            Error: {error}
          </p>
        )}
        {!error && devices.length === 0 && (
          <p className="has-text-grey">No devices found</p>
        )}

        <ul className="device-list device-list-scroll">
          {devices.map((device) => {
            const isSelected =
              selected !== null &&
              selected.name === device.name &&
              selected.driver === device.driver;

            return (
              <li
                key={`${device.name}·${device.driver ?? ""}`}
                className={"device-item" + (isSelected ? " is-selected" : "")}
                onClick={() => onToggle(device)}
              >
                <div className="device-line">
                  <span className="subtitle is-6 mb-0">
                    {device.name}
                  </span>
                  {device.isDefault && (
                    <span className="tag is-info">default</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {outputs.length > 0 && (
          <div className="mt-5">
            <div className="has-text-weight-semibold mb-1">Audio output</div>
            <ul className="device-list">
              {outputs.map((device) => {
                const isSelected = selectedOutput === device.name;

                return (
                  <li
                    key={`out·${device.name}`}
                    className={"device-item" + (isSelected ? " is-selected" : "")}
                    onClick={() => onToggleOutput(device)}
                  >
                    <div className="device-line">
                      <span className="subtitle is-6 mb-0">
                        {device.name === "default_sink"
                          ? "System default output"
                          : device.name}
                      </span>
                      {device.isDefault && (
                        <span className="tag is-info">default</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }
}

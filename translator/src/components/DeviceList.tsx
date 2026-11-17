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

interface DeviceListProps {
  devices: AudioInputDevice[];
  selected: AudioInputDevice | null;
  error: string | null;
  /** Called when the user clicks a device row (toggle selection). */
  onToggle: (device: AudioInputDevice) => void;
}

/** Human-readable summary line for a device, e.g.
 *  "plughw:CARD=Seri,DEV=0 · Plantronics · Microphone · 2 ch · 48000 Hz · F32". */
function describeDevice(device: AudioInputDevice): string | null {
  return [
    device.driver,
    device.manufacturer,
    device.deviceType,
    device.defaultConfig
      ? `${device.defaultConfig.channels} ch · ${device.defaultConfig.sampleRate} Hz · ${device.defaultConfig.sampleFormat}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The list of audio input devices; clicking a row toggles its selection. */
export class DeviceList extends Component<DeviceListProps> {
  render() {
    const { devices, selected, error, onToggle } = this.props;

    return (
      <div className="devices-section">
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
            const meta = describeDevice(device);
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
                <span className="has-text-weight-semibold">
                  {device.name}
                </span>
                {device.isDefault && <span className="tag is-info">default</span>}
                {meta && <span className="device-meta">{meta}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
}

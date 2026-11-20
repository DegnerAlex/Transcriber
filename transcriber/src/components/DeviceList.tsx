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

import { Component } from "preact/compat";
import { FaCheck, FaMicrophone, FaRotate, FaVolumeHigh } from "react-icons/fa6";

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

/** Drops empty and "unknown"-style values from a device fact list. */
function meaningful(values: Array<string | null | undefined>): string[] {
  return values.filter((part): part is string => {
    const value = (part ?? "").trim();
    return value.length > 0 && !/^(unknown|n\/a|-)$/i.test(value);
  });
}

/** Joins the meaningful device facts, skipping empty and "unknown" ones. */
function metaLine(device: AudioInputDevice): string {
  return meaningful([
    device.driver ?? device.interface,
    device.manufacturer,
    configSummary(device.defaultConfig),
  ]).join(" · ");
}

/** Meta line for an output device. */
function outputMetaLine(device: AudioOutputDevice): string {
  return meaningful([device.interface, device.deviceType]).join(" · ");
}

/** Human-readable capture configuration, e.g. `2 ch · 48 kHz · f32`. */
function configSummary(config: AudioInputConfig | null): string {
  if (!config) return "";
  const parts = [
    `${config.channels} ch`,
    `${Math.round(config.sampleRate / 1000)} kHz`,
    config.sampleFormat,
  ];
  return parts.join(" · ");
}

/** The audio device lists: input devices and capturable output sinks. */
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
        <div className="section-header">
          <span className="section-label">Audio input</span>
          <button
            type="button"
            className="button is-small refresh-button"
            onClick={onRefresh}
            title="Re-enumerate devices"
          >
            <FaRotate />
          </button>
        </div>

        {error && (
          <p className="notification is-danger is-light py-1 px-2 is-size-7">
            Error: {error}
          </p>
        )}
        {!error && devices.length === 0 && (
          <p className="device-empty">No devices found</p>
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
                <span className="device-icon">
                  <FaMicrophone />
                </span>
                <span className="device-info">
                  <span className="device-name">
                    {device.name === "default_input"
                      ? "System default input"
                      : device.name}
                  </span>
                  {metaLine(device) && (
                    <span className="device-meta">{metaLine(device)}</span>
                  )}
                </span>
                {device.isDefault && <span className="device-badge">default</span>}
                {isSelected && (
                  <span className="device-check">
                    <FaCheck />
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {outputs.length > 0 && (
          <div className="mt-4">
            <div className="section-header">
              <span className="section-label">Audio output</span>
            </div>
            <ul className="device-list">
              {outputs.map((device) => {
                const isSelected = selectedOutput === device.name;

                return (
                  <li
                    key={`out·${device.name}`}
                    className={"device-item" + (isSelected ? " is-selected" : "")}
                    onClick={() => onToggleOutput(device)}
                  >
                    <span className="device-icon">
                      <FaVolumeHigh />
                    </span>
                    <span className="device-info">
                      <span className="device-name">
                        {device.name === "default_sink"
                          ? "System default output"
                          : device.name === "default_input"
                              ? "System default input"
                              : device.name}
                      </span>
                      {outputMetaLine(device) && (
                        <span className="device-meta">
                          {outputMetaLine(device)}
                        </span>
                      )}
                    </span>
                    {device.isDefault && <span className="device-badge">default</span>}
                    {isSelected && (
                      <span className="device-check">
                        <FaCheck />
                      </span>
                    )}
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

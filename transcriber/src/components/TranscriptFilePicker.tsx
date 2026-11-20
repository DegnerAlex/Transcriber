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
import { FaFolderOpen, FaXmark } from "react-icons/fa6";

interface TranscriptFilePickerProps {
  /** The file the transcript is mirrored into; `null` = mirroring is off. */
  file: string | null;
  /** Opens the native save dialog to (re)choose the file. */
  onPick: () => void;
  /** Stops mirroring (keeps the transcript itself). */
  onUnlink: () => void;
}

/**
 * The transcript-file controls: the pick button and, when a file is chosen,
 * a chip showing its name with an unlink button.
 */
export class TranscriptFilePicker extends Component<TranscriptFilePickerProps> {
  render() {
    const {file, onPick, onUnlink} = this.props;

    return (
      <>
        <button
          type="button"
          className="icon-button"
          title={
            file
              ? `Mirroring the transcript to ${file}`
              : "Choose a file to mirror the transcript into"
          }
          onClick={onPick}
        >
          <FaFolderOpen/>
        </button>
        {file && (
          <span className="transcript-file-chip" title={file}>
            <span className="transcript-file-name">
              {file.split(/[\\/]/).pop()}
            </span>
            <button
              type="button"
              className="icon-button is-tiny"
              title="Stop mirroring the transcript"
              onClick={onUnlink}
            >
              <FaXmark/>
            </button>
          </span>
        )}
      </>
    );
  }
}

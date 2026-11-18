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

import {Component} from "react";
import {FaMicrochip} from "react-icons/fa6";

interface BackendBadgeProps {
    /** Transcription backend as reported by the engine: "cuda", "vulkan"
     *  or "cpu". */
    backend: string;
}

/** The backend badge in the Language/Model row: green "GPU CUDA" /
 *  "GPU VULKAN" for the GPU paths, yellow "CPU" for the fallback. The
 *  backend is fixed at startup. */
export class BackendBadge extends Component<BackendBadgeProps> {
    render() {
        const {backend} = this.props;
        const label =
            backend === "cuda"
                ? "GPU CUDA"
                : backend === "vulkan"
                    ? "GPU VULKAN"
                    : "CPU";
        const title =
            backend === "cuda"
                ? "Transcription runs on the NVIDIA GPU (CUDA)"
                : backend === "vulkan"
                    ? "Transcription runs on the GPU (Vulkan)"
                    : "Transcription runs on the CPU";
        return (
            <span
                className={"tag " + (backend === "cpu" ? "tag-cpu" : "tag-gpu")}
                title={title}
                style={{marginLeft: "auto"}}
            >
                <FaMicrochip style={{marginRight: "0.3rem"}}/>
                {label}
            </span>
        );
    }
}

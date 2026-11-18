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

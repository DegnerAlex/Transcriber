import {Component} from "react";
import {FaMicrochip} from "react-icons/fa6";

interface BackendBadgeProps {
    /** Transcription backend as reported by the engine: "gpu" or "cpu". */
    backend: string;
}

/** The GPU/CPU badge in the Language/Model row: green for CUDA, yellow
 *  for the CPU fallback. The backend is fixed at startup. */
export class BackendBadge extends Component<BackendBadgeProps> {
    render() {
        const {backend} = this.props;
        const gpu = backend === "gpu";
        return (
            <span
                className={"tag " + (gpu ? "tag-gpu" : "tag-cpu")}
                title={
                    gpu
                        ? "Transcription runs on the NVIDIA GPU (CUDA)"
                        : "Transcription runs on the CPU"
                }
                style={{marginLeft: "auto"}}
            >
                <FaMicrochip style={{marginRight: "0.3rem"}}/>
                {backend.toUpperCase()}
            </span>
        );
    }
}

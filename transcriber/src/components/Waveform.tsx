import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

interface LevelUpdate {
  peaks: number[];
  rms: number;
}

const BAR_WIDTH = 2;
const BAR_GAP = 1;
const MAX_HISTORY = 480;

/**
 * Extra display-only amplification. Raw mic peaks usually sit around
 * 0.05..0.3 of full scale, so they draw as tiny bars; this factor makes the
 * waveform readable without touching the actual capture gain.
 */
const VISUAL_GAIN = 4;

/**
 * Scrolling waveform fed by "audio-level" events. Renders an idle flat line
 * when `active` is false (no device selected).
 */
export function Waveform({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<number[]>([]);

  useEffect(() => {
    if (active) {
      historyRef.current = [];
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let raf = 0;

    if (active) {
      listen<LevelUpdate>("audio-level", (event) => {
        const history = historyRef.current;
        history.push(...event.payload.peaks);
        if (history.length > MAX_HISTORY) {
          history.splice(0, history.length - MAX_HISTORY);
        }
      }).then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      });
    }

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Center line
      ctx.strokeStyle = "rgba(127, 127, 127, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      if (!active) return;

      const history = historyRef.current;
      const count = history.length;
      if (count === 0) return;

      const maxBars = Math.ceil(width / (BAR_WIDTH + BAR_GAP));
      const start = Math.max(0, count - maxBars);
      ctx.fillStyle = "#3e8ed0";
      for (let i = start; i < count; i++) {
        const x = width - (count - i) * (BAR_WIDTH + BAR_GAP);
        const amplitude = Math.min(
          1,
          Math.abs(history[i]) * VISUAL_GAIN,
        );
        const barHeight = Math.max(2, amplitude * (height - 4));
        ctx.fillRect(x, (height - barHeight) / 2, BAR_WIDTH, barHeight);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className={"waveform" + (active ? "" : " is-idle")}
    />
  );
}

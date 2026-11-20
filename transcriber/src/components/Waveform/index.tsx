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

import { useEffect, useRef } from "preact/compat";
import { listen } from "@tauri-apps/api/event";
import { WaveformRenderer } from "./WaveformRenderer";

interface LevelUpdate {
  peaks: number[];
  rms: number;
}

/**
 * Scrolling waveform fed by "audio-level" events, rendered with pixi.js
 * (see WaveformRenderer.ts). Renders an idle flat line when `active` is
 * false (no device selected).
 */
export function Waveform({ active }: { active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WaveformRenderer | null>(null);

  // The renderer lives for the whole component lifetime; `active` only
  // toggles its capture mode.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new WaveformRenderer();
    rendererRef.current = renderer;
    renderer.mount(host);

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    renderer.setActive(active);
    if (!active) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<LevelUpdate>("audio-level", (event) => {
      rendererRef.current?.pushPeaks(event.payload.peaks);
    }).then((stop) => {
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active]);

  return <div ref={hostRef} className={"waveform" + (active ? "" : " is-idle")} />;
}

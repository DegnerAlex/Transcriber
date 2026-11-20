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

import { Application, Graphics } from "pixi.js";

const BAR_WIDTH = 2;
const BAR_GAP = 1;
const MAX_HISTORY = 480;

/**
 * Extra display-only amplification. Raw mic peaks usually sit around
 * 0.05..0.3 of full scale, so they draw as tiny bars; this factor makes the
 * waveform readable without touching the actual capture gain.
 */
const VISUAL_GAIN = 4;

const BAR_COLOR = 0x3e8ed0;
const CENTER_LINE = { color: 0x7f7f7f, alpha: 0.35, width: 1 };

/**
 * Owns the pixi.js scene for the microphone waveform: a scrolling bar
 * envelope fed by "audio-level" events, with an idle center line when no
 * device is capturing. Redraws only when the data or the size changes.
 */
export class WaveformRenderer {
  private app: Application | null = null;
  private container: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private started = false;
  private disposed = false;

  private axis: Graphics | null = null;
  private bars: Graphics | null = null;
  private history: number[] = [];
  private active = false;
  private renderedSize = { width: 0, height: 0 };

  /** Creates the application inside `container` and starts observing it. */
  mount(container: HTMLElement, onReady?: () => void): void {
    if (this.started) return;
    this.started = true;
    this.disposed = false;
    this.container = container;

    void (async () => {
      const app = new Application();
      await app.init({
        width: 1,
        height: 1,
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.max(1, window.devicePixelRatio || 1),
        autoDensity: true,
        preference: "webgl",
      });
      if (this.disposed) {
        app.destroy(true, { children: true });
        return;
      }

      const canvas = app.canvas as HTMLCanvasElement;
      canvas.className = "waveform";
      container.appendChild(canvas);

      this.app = app;
      this.axis = new Graphics();
      this.bars = new Graphics();
      app.stage.addChild(this.axis, this.bars);

      this.observer = new ResizeObserver(() => this.draw());
      this.observer.observe(container);

      this.draw();
      onReady?.();
    })().catch((error) => {
      console.warn("pixi waveform is unavailable", error);
    });
  }

  /** Toggles capture mode: idle shows the bare center line and dims the view. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.history = [];
    }
    (this.app?.canvas as HTMLCanvasElement | undefined)?.classList.toggle(
      "is-idle",
      !active,
    );
    this.draw();
  }

  /** Appends one batch of mic peak values to the scrolling history. */
  pushPeaks(peaks: number[]): void {
    const history = this.history;
    history.push(...peaks);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    this.draw();
  }

  /** Redraws the scene; syncs the renderer size with the host element. */
  private draw(): void {
    const app = this.app;
    const axis = this.axis;
    const bars = this.bars;
    if (!app || !axis || !bars) {
      return;
    }

    const width = Math.max(1, this.container?.clientWidth ?? 0);
    const height = Math.max(1, this.container?.clientHeight ?? 0);
    if (
      this.renderedSize.width !== width ||
      this.renderedSize.height !== height
    ) {
      app.renderer.resize(width, height);
      this.renderedSize = { width, height };
    }

    axis.clear();
    axis.moveTo(0, height / 2).lineTo(width, height / 2).stroke(CENTER_LINE);

    bars.clear();
    if (!this.active) return;

    const history = this.history;
    const count = history.length;
    if (count === 0) return;

    const maxBars = Math.ceil(width / (BAR_WIDTH + BAR_GAP));
    const start = Math.max(0, count - maxBars);
    for (let i = start; i < count; i++) {
      const x = width - (count - i) * (BAR_WIDTH + BAR_GAP);
      const amplitude = Math.min(1, Math.abs(history[i]) * VISUAL_GAIN);
      const barHeight = Math.max(2, amplitude * (height - 4));
      bars.rect(x, (height - barHeight) / 2, BAR_WIDTH, barHeight).fill(BAR_COLOR);
    }
  }

  /** Tears the renderer down and releases GPU resources. */
  destroy(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.app?.destroy(true, { children: true });
    this.app = null;
    this.axis = null;
    this.bars = null;
    this.container = null;
    this.history = [];
    this.renderedSize = { width: 0, height: 0 };
  }
}

/**
 * Architectural Pixel-Grid Cursor Trail (`src/media/pixel-trail.ts`)
 *
 * Renders a subtle square architectural grid inside selected structural containers
 * and illuminates crisp trailing pixel cells along mouse/touch movement using
 * BLUEDROP's restrained 4-color Blocks palette (#F4F03A, #6E8BFF, #FFA8E4, #B9F0C6).
 */

const BLOCKS_TRAIL_PALETTE = ['#F4F03A', '#6E8BFF', '#FFA8E4', '#B9F0C6'] as const;

interface ActiveCell {
  key: string;
  col: number;
  row: number;
  color: string;
  alpha: number;
}

export class PixelTrailController {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly cellSize: number;
  private readonly gridLineColor: string;
  private readonly showBaseGrid: boolean;
  private readonly cells = new Map<string, ActiveCell>();
  private resizeObs: ResizeObserver | null = null;
  private rafId = 0;
  private lastTs = 0;
  private colorCursor = 0;
  private lastCellKey = '';
  private destroyed = false;
  private readonly reducedMotion: boolean;

  constructor(
    host: HTMLElement,
    options?: { cellSize?: number; gridLineColor?: string; showBaseGrid?: boolean }
  ) {
    this.host = host;
    this.cellSize = options?.cellSize ?? 24;
    this.gridLineColor = options?.gridLineColor ?? 'rgba(255, 255, 255, 0.045)';
    this.showBaseGrid = options?.showBaseGrid ?? true;
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bd-pixel-trail-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');

    if (getComputedStyle(this.host).position === 'static') {
      this.host.style.position = 'relative';
    }
    this.host.prepend(this.canvas);

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(this.host);
    }

    this.host.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.host.addEventListener('pointerdown', this.onPointerMove, { passive: true });

    if (this.showBaseGrid) {
      this.drawFrame(0);
    }
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.ctx) {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (this.showBaseGrid) {
      this.drawFrame(0);
    }
  }

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (this.reducedMotion || this.destroyed) return;
    const rect = this.host.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    const key = `${col}:${row}`;
    if (key === this.lastCellKey && this.cells.has(key)) return;
    this.lastCellKey = key;

    this.spawnCell(col, row, 0.86);
    // Subtle orthogonal neighbor pixel for authentic stepped trail feel
    if (Math.random() > 0.45) {
      const dx = Math.random() > 0.5 ? 1 : -1;
      const dy = Math.random() > 0.5 ? 1 : 0;
      this.spawnCell(col + dx, row + dy, 0.42);
    }

    if (!this.rafId) {
      this.lastTs = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private spawnCell(col: number, row: number, alpha: number): void {
    if (col < 0 || row < 0) return;
    const key = `${col}:${row}`;
    const color = BLOCKS_TRAIL_PALETTE[this.colorCursor % BLOCKS_TRAIL_PALETTE.length]!;
    this.colorCursor += 1;
    this.cells.set(key, { key, col, row, color, alpha });
    if (this.cells.size > 90) {
      const oldest = this.cells.keys().next().value;
      if (oldest) this.cells.delete(oldest);
    }
  }

  private readonly tick = (now: number): void => {
    if (this.destroyed) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTs) / 1000));
    this.lastTs = now;
    this.drawFrame(dt);
    if (this.cells.size > 0) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = 0;
    }
  };

  private drawFrame(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const s = this.cellSize;

    ctx.clearRect(0, 0, w, h);

    if (this.showBaseGrid) {
      ctx.strokeStyle = this.gridLineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += s) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += s) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
    }

    for (const [key, cell] of this.cells.entries()) {
      if (dt > 0) {
        cell.alpha -= dt * 1.45;
      }
      if (cell.alpha <= 0.02) {
        this.cells.delete(key);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = cell.alpha * 0.65;
      ctx.fillStyle = cell.color;
      ctx.fillRect(cell.col * s + 1, cell.row * s + 1, s - 2, s - 2);
      ctx.restore();
    }
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    this.host.removeEventListener('pointermove', this.onPointerMove);
    this.host.removeEventListener('pointerdown', this.onPointerMove);
    this.canvas.remove();
  }
}

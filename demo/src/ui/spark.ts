// demo/src/ui/spark.ts -- the frame-time sparkline over a preallocated
// Float64Array(256) ring buffer, indexed with a power-of-2 bitmask (255). The
// buffer and every scratch number are allocated ONCE at construction; push()
// and draw() allocate nothing (lite-law: pre-allocated typed-array ring, mask
// index, no per-frame literals). draw() does layout READS (canvas sizing) only
// on an explicit resize(), never interleaved with a write, so no forced reflow.
//
// ASCII-only.

const RING = 256;
const MASK = 255;

export class Spark {
    private readonly buf = new Float64Array(RING);
    private head = 0;
    private len = 0;
    private readonly ctx: CanvasRenderingContext2D;
    private w = 0;
    private h = 0;
    private dpr = 1;

    constructor(private readonly canvas: HTMLCanvasElement, private readonly budgetMs: number) {
        const ctx = canvas.getContext("2d");
        if (ctx === null) throw new Error("spark: no 2d context");
        this.ctx = ctx;
        this.resize();
    }

    // Layout READ isolated here; called on boot and on resize events, never from
    // inside the frame's write path.
    resize(): void {
        const r = this.canvas.getBoundingClientRect();
        if (r.width < 2) return;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.w = r.width;
        this.h = r.height;
        this.canvas.width = Math.round(this.w * this.dpr);
        this.canvas.height = Math.round(this.h * this.dpr);
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    push(ms: number): void {
        this.buf[this.head] = ms;
        this.head = (this.head + 1) & MASK;
        if (this.len < RING) this.len = this.len + 1;
    }

    // Pure WRITE path (no layout reads): clear, budget line, area, stroke.
    draw(line: string, fill: string, guide: string): void {
        const ctx = this.ctx;
        const w = this.w;
        const h = this.h;
        if (w < 2) return;
        const maxMs = this.budgetMs * 2;
        ctx.clearRect(0, 0, w, h);

        const by = h - (this.budgetMs / maxMs) * h;
        ctx.strokeStyle = guide;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, by);
        ctx.lineTo(w, by);
        ctx.stroke();

        const n = this.len;
        if (n < 2) return;
        const stepX = w / (RING - 1);

        ctx.beginPath();
        for (let k = 0; k < n; k++) {
            const idx = (this.head - n + k + RING * 2) & MASK;
            let v = this.buf[idx];
            if (v > maxMs) v = maxMs;
            const x = k * stepX;
            const y = h - (v / maxMs) * h;
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        const lastX = (n - 1) * stepX;
        ctx.lineTo(lastX, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.beginPath();
        for (let k = 0; k < n; k++) {
            const idx = (this.head - n + k + RING * 2) & MASK;
            let v = this.buf[idx];
            if (v > maxMs) v = maxMs;
            const x = k * stepX;
            const y = h - (v / maxMs) * h;
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

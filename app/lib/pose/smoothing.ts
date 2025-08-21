/**
 * One-Euro filter for 2D keypoints + light outlier clamp.
 * Ref: "The One Euro Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 * https://cristal.univ-lille.fr/~casiez/1euro/
 */

export type Pt = { x: number; y: number; visibility?: number };

function alpha(dt: number, cutoff: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / (dt || 1e-6));
}

class LowPass {
  private y = 0;
  private a = 0;
  private init = false;
  constructor(private cutoff: number) {}
  filter(x: number, dt: number) {
    const a = alpha(dt, this.cutoff);
    this.a = a;
    if (!this.init) {
      this.init = true;
      this.y = x;
      return x;
    }
    this.y = this.y + a * (x - this.y);
    return this.y;
  }
}

class OneEuro1D {
  private xLP: LowPass;
  private dxLP: LowPass;
  private lastX = 0;
  private lastT = 0;
  private init = false;

  constructor(
    private minCutoff = 1.2, // baseline smoothing
    private beta = 0.007,    // speed coefficient
    private dCutoff = 1.0    // derivative cutoff
  ) {
    this.xLP = new LowPass(minCutoff);
    this.dxLP = new LowPass(dCutoff);
  }

  filter(x: number, t: number) {
    if (!this.init) {
      this.init = true;
      this.lastX = x;
      this.lastT = t;
      return x;
    }
    const dt = Math.max(1e-4, t - this.lastT);
    const dx = (x - this.lastX) / dt;
    const edx = this.dxLP.filter(dx, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const result = this.xLP.filter(x, dt * cutoff / this.minCutoff); // normalize LP step
    this.lastX = x;
    this.lastT = t;
    return result;
  }
}

/**
 * PoseSmoother holds a bank of filters: 2 per keypoint (x,y).
 * Includes a simple "despike": if a jump > maxJump happens in one frame,
 * we clamp it towards previous value to avoid teleporting joints.
 */
export class PoseSmoother {
  private fx: OneEuro1D[] = [];
  private fy: OneEuro1D[] = [];
  private prev: Pt[] | null = null;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.007,
    private dCutoff = 1.0,
    private maxJump = 0.08,     // max per-frame jump in normalized coords
    private visThresh = 0.15    // ignore very low-visibility points
  ) {}

  private ensureSize(n: number) {
    while (this.fx.length < n) this.fx.push(new OneEuro1D(this.minCutoff, this.beta, this.dCutoff));
    while (this.fy.length < n) this.fy.push(new OneEuro1D(this.minCutoff, this.beta, this.dCutoff));
  }

  apply(kps: Pt[], timeSec: number): Pt[] {
    const n = kps.length;
    this.ensureSize(n);
    const out: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = kps[i];
      const v = p.visibility ?? 0;
      // If point is basically invisible, keep previous (or pass through)
      if (v < this.visThresh) {
        out[i] = this.prev?.[i] ?? { ...p };
        continue;
      }
      // Despike: clamp big instantaneous jumps
      const prev = this.prev?.[i];
      const px = prev?.x ?? p.x;
      const py = prev?.y ?? p.y;
      const dx = p.x - px;
      const dy = p.y - py;
      const mag = Math.hypot(dx, dy);
      let x = p.x, y = p.y;
      if (mag > this.maxJump) {
        const scale = this.maxJump / mag;
        x = px + dx * scale;
        y = py + dy * scale;
      }

      out[i] = {
        x: this.fx[i].filter(x, timeSec),
        y: this.fy[i].filter(y, timeSec),
        visibility: p.visibility
      };
    }
    this.prev = out.map(q => ({ ...q })); // deep-ish copy for next frame
    return out;
  }
}


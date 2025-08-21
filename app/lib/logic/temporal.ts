/**
 * TemporalGate: only returns true if a condition was true
 * at least `need` times within the last `max` frames.
 * Great for debouncing noisy pose signals.
 */
export class TemporalGate {
    private buf: boolean[] = []
    constructor(private max = 6, private need = 4) {}
    push(v: boolean): boolean {
      this.buf.push(v)
      if (this.buf.length > this.max) this.buf.shift()
      return this.buf.filter(Boolean).length >= this.need
    }
    reset() { this.buf = [] }
  }
  
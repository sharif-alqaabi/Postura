// Simple rules → spoken cues
export interface Cue {
    type: 'depth' | 'trunk' | 'knee'
    message: string
  }
  
  export function checkRules(kneeDeg: number | null, trunkDeg: number | null): Cue[] {
    const cues: Cue[] = []
    // If knee angle is too open (i.e., you didn’t get deep), nudge depth
    if (kneeDeg != null && kneeDeg > 140) cues.push({ type: 'depth', message: 'Go deeper' })
    // If torso leans too far from vertical, nudge posture
    if (trunkDeg != null && trunkDeg > 35) cues.push({ type: 'trunk', message: 'Chest up' })
    // (We’ll add knees-in later when we compute ankle/knee spread)
    return cues
  }
  
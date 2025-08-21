/**
 * MediaPipe Pose: indices for key joints + which ones we connect with lines.
 * We only include the main limbs/torso needed for squats.
 */
export const KP = {
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,
    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28,
  } as const
  
  // Pairs of joints to draw as “bones”
  export const EDGES: [number, number][] = [
    [KP.LEFT_SHOULDER, KP.RIGHT_SHOULDER],
    [KP.LEFT_HIP, KP.RIGHT_HIP],
    [KP.LEFT_SHOULDER, KP.LEFT_ELBOW],
    [KP.LEFT_ELBOW, KP.LEFT_WRIST],
    [KP.RIGHT_SHOULDER, KP.RIGHT_ELBOW],
    [KP.RIGHT_ELBOW, KP.RIGHT_WRIST],
    [KP.LEFT_HIP, KP.LEFT_KNEE],
    [KP.LEFT_KNEE, KP.LEFT_ANKLE],
    [KP.RIGHT_HIP, KP.RIGHT_KNEE],
    [KP.RIGHT_KNEE, KP.RIGHT_ANKLE],
  ]
  
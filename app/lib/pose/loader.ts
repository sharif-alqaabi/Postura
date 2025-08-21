/**
 * MediaPipe Pose loader + per-frame inference helper (typed).
 * Uses slightly higher tracking/presence confidences for stability.
 */
import {
  FilesetResolver,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';

export type PoseKeypoint = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};
export type PoseResult = { keypoints: PoseKeypoint[]; timestamp: number };

// Cache the model so we only load it once.
let landmarker: PoseLandmarker | null = null;

/** One-time model load (idempotent). */
export async function initPose(): Promise<void> {
  if (landmarker) return;

  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
  );

  landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      // "lite" is fast; switch to "full" on strong phones if needed.
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    // Slightly stricter for fewer flickers
    minPoseDetectionConfidence: 0.6,
    minPosePresenceConfidence: 0.65,
    minTrackingConfidence: 0.7,
  });
}

export function isReady() {
  return !!landmarker;
}

/** Run pose detection for the current video frame. */
export function detectPose(
  video: HTMLVideoElement,
  ts: number
): PoseResult | null {
  if (!landmarker) return null;
  const result = landmarker.detectForVideo(video, ts);

  const raw: Array<{ x: number; y: number; z?: number; visibility?: number }> =
    (result?.landmarks?.[0] ?? []) as Array<{
      x: number; y: number; z?: number; visibility?: number;
    }>;

  const keypoints: PoseKeypoint[] = raw.map((p) => ({
    x: p.x, y: p.y, z: p.z, visibility: p.visibility,
  }));

  return { keypoints, timestamp: ts };
}


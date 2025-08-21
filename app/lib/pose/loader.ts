/**
 * MediaPipe Pose loader + per-frame inference helper (typed).
 * - initPose(): one-time model load
 * - detectPose(video, ts): run inference for a given video frame timestamp
 */
import {
    FilesetResolver,
    PoseLandmarker,
    // These types exist in recent versions; if your editor doesn't see them,
    // the fallback type assertions below still keep TS happy.
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
  
  /**
   * Load the WASM runtime + the "lite" pose model for better FPS on phones.
   * Idempotent: safe to call multiple times.
   */
  export async function initPose(): Promise<void> {
    if (landmarker) return;
  
    // Tell MediaPipe where to load its WASM files.
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
    );
  
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        // You can self-host this later if you want. This is fine for dev.
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }
  
  export function isReady() {
    return !!landmarker;
  }
  
  /**
   * Run pose detection for the current video frame.
   * @param video <video> element (already playing)
   * @param ts    performance.now() timestamp
   * @returns     keypoints in normalized [0..1] coords (or null if not ready)
   */
  export function detectPose(
    video: HTMLVideoElement,
    ts: number
  ): PoseResult | null {
    if (!landmarker) return null;
  
    const result = landmarker.detectForVideo(video, ts);
  
    // result.landmarks?.[0] is an array of points with {x,y,z,visibility}.
    // We assert the shape so the map() callback param isn't 'any'.
    const raw: Array<{ x: number; y: number; z?: number; visibility?: number }> =
      (result?.landmarks?.[0] ?? []) as Array<{
        x: number;
        y: number;
        z?: number;
        visibility?: number;
      }>;
  
    const keypoints: PoseKeypoint[] = raw.map((p) => ({
      x: p.x,
      y: p.y,
      z: p.z,
      visibility: p.visibility,
    }));
  
    return { keypoints, timestamp: ts };
  }
  
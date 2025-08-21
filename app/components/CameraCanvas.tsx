'use client'
import { useEffect, useRef, useState } from 'react'
import { initPose, detectPose, isReady } from '@/app/lib/pose/loader'
import { EDGES, KP } from '@/app/lib/pose/topology'
import { angleABC, trunkAngle, ema } from '@/app/lib/math/angles'
import { createFSM, stepFSM } from '@/app/lib/logic/fsm'
import { useTTS } from '@/app/lib/audio/useTTS'
import { checkRules } from '@/app/lib/logic/rules'

/**
 * Camera + overlay + angles + rep FSM + TTS cues
 * - Click "Enable Coaching Audio" once to allow speech (browser policy).
 * - We only speak at most one cue every ~1.2s (useTTS handles gap).
 * - We also avoid repeating the same cue twice in the same rep.
 */
export default function CameraCanvas() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [fps, setFps] = useState(0)
  const [kneeDeg, setKneeDeg] = useState<number | null>(null)
  const [trunkDeg, setTrunkDeg] = useState<number | null>(null)
  const [reps, setReps] = useState(0)

  // TTS hook: enable() must be called by a user gesture
  const { enabled, enable, speak } = useTTS(1200)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // smoothing accumulators
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // rep state
    let fsm = createFSM()

    // simple anti-spam: remember which cue we already spoke this rep
    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    async function start() {
      await initPose()
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      })
      const v = videoRef.current!
      const c = canvasRef.current!
      const g = c.getContext('2d')!
      v.srcObject = stream
      await v.play()

      const loop = () => {
        const now = performance.now()
        const dt = now - last
        if (dt > 0) setFps(1000 / dt)
        last = now

        if (!isReady()) {
          raf = requestAnimationFrame(loop)
          return
        }
        const res = detectPose(v, now)

        // canvas sizing + clear
        c.width = v.videoWidth
        c.height = v.videoHeight
        g.clearRect(0, 0, c.width, c.height)

        if (res && res.keypoints.length) {
          const kps = res.keypoints

          // draw bones
          g.lineWidth = 3
          g.globalAlpha = 0.9
          g.strokeStyle = '#ffffff'
          EDGES.forEach(([a, b]) => {
            const p = kps[a]; const q = kps[b]
            if ((p?.visibility ?? 0) > 0.3 && (q?.visibility ?? 0) > 0.3) {
              g.beginPath()
              g.moveTo(p.x * c.width, p.y * c.height)
              g.lineTo(q.x * c.width, q.y * c.height)
              g.stroke()
            }
          })
          // draw joints
          g.fillStyle = '#ffffff'
          kps.forEach((pt) => {
            if ((pt.visibility ?? 0) > 0.3) {
              g.beginPath()
              g.arc(pt.x * c.width, pt.y * c.height, 4, 0, Math.PI * 2)
              g.fill()
            }
          })

          // angles
          const leftKnee = angleABC(
            { x: kps[KP.LEFT_HIP].x, y: kps[KP.LEFT_HIP].y },
            { x: kps[KP.LEFT_KNEE].x, y: kps[KP.LEFT_KNEE].y },
            { x: kps[KP.LEFT_ANKLE].x, y: kps[KP.LEFT_ANKLE].y },
          )
          const rightKnee = angleABC(
            { x: kps[KP.RIGHT_HIP].x, y: kps[KP.RIGHT_HIP].y },
            { x: kps[KP.RIGHT_KNEE].x, y: kps[KP.RIGHT_KNEE].y },
            { x: kps[KP.RIGHT_ANKLE].x, y: kps[KP.RIGHT_ANKLE].y },
          )
          const knee = (leftKnee + rightKnee) / 2
          kneeSmoothed = ema(kneeSmoothed, knee)
          setKneeDeg(Math.round(kneeSmoothed!))

          const hipC = {
            x: (kps[KP.LEFT_HIP].x + kps[KP.RIGHT_HIP].x) / 2,
            y: (kps[KP.LEFT_HIP].y + kps[KP.RIGHT_HIP].y) / 2,
          }
          const shC = {
            x: (kps[KP.LEFT_SHOULDER].x + kps[KP.RIGHT_SHOULDER].x) / 2,
            y: (kps[KP.LEFT_SHOULDER].y + kps[KP.RIGHT_SHOULDER].y) / 2,
          }
          const trunk = trunkAngle(hipC, shC)
          trunkSmoothed = ema(trunkSmoothed, trunk)
          setTrunkDeg(Math.round(trunkSmoothed!))

          // depth heuristic
          const lDepth = kps[KP.LEFT_HIP].y > kps[KP.LEFT_KNEE].y
          const rDepth = kps[KP.RIGHT_HIP].y > kps[KP.RIGHT_KNEE].y
          const depthOkay = lDepth && rDepth

          // FSM step + rep tracking
          const prevReps = fsm.reps
          fsm = stepFSM(fsm, hipC.y, depthOkay)
          setReps(fsm.reps)

          // If we just completed a rep, clear per-rep spoken flag
          if (fsm.reps !== prevReps) {
            spokeCueTypeThisRep = null
          }

          // SPEAK CUES (one per ~1.2s; and not twice per rep)
          const cues = checkRules(kneeSmoothed ?? knee, trunkSmoothed ?? trunk)
          if (enabled && cues.length) {
            const first = cues.find(c => c.type !== spokeCueTypeThisRep) || cues[0]
            if (first.type !== spokeCueTypeThisRep) {
              speak(first.message)
              spokeCueTypeThisRep = first.type
            }
          }

          // HUD
          g.fillStyle = '#ffffff'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fps)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeSmoothed || knee)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkSmoothed || trunk)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
        }

        raf = requestAnimationFrame(loop)
      }

      raf = requestAnimationFrame(loop)
    }

    start().catch(console.error)
    return () => cancelAnimationFrame(raf)
  }, [enabled, speak]) // re-run loop if TTS state changes

  return (
    <div style={{ maxWidth: 420, marginInline: 'auto', position: 'relative' }}>
      {/* Button is needed once to enable speech on iOS/Chrome */}
      {!enabled && (
        <button
          onClick={enable}
          style={{ padding: '8px 12px', borderRadius: 12, border: '1px solid #444', marginBottom: 12 }}
        >
          Enable Coaching Audio
        </button>
      )}

      <div style={{ position: 'relative' }}>
        <video ref={videoRef} className="w-full rounded-2xl" playsInline muted />
        <canvas ref={canvasRef} className="w-full h-full absolute inset-0 pointer-events-none" />
      </div>
      <div className="text-xs opacity-70 mt-2">
        FPS: {fps.toFixed(1)} | Reps: {reps} | Knee: {kneeDeg ?? '-'}° | Trunk: {trunkDeg ?? '-'}°
      </div>
    </div>
  )
}

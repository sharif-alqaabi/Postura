'use client'
import { useEffect, useRef, useState } from 'react'
import { initPose, detectPose, isReady } from '@/app/lib/pose/loader'
import { EDGES, KP } from '@/app/lib/pose/topology'
import { angleABC, trunkAngle, ema } from '@/app/lib/math/angles'
import { createFSM, stepFSM } from '@/app/lib/logic/fsm'
import { useTTS } from '@/app/lib/audio/useTTS'
import { TemporalGate } from '@/app/lib/logic/temporal'
import { checkRulesAtBottom } from '@/app/lib/logic/rules'

export default function CameraCanvas() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [fps, setFps] = useState(0)
  const [kneeDeg, setKneeDeg] = useState<number | null>(null)
  const [trunkDeg, setTrunkDeg] = useState<number | null>(null)
  const [reps, setReps] = useState(0)
  const [camError, setCamError] = useState<string | null>(null)

  const { enabled, enable, speak } = useTTS(1200)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // smoothing accumulators
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // state machine + last state (to detect transitions)
    let fsm = createFSM()
    let lastState = fsm.state

    // temporal gate for depth (require 4/6 recent frames true)
    const depthGate = new TemporalGate(6, 4)

    // Avoid repeating the same cue within one rep
    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    async function start() {
      await initPose()

      // Guard for HTTPS / permissions
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCamError('Camera not available. Use localhost on desktop or HTTPS (Vercel/ngrok) on mobile.')
        return
      }

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

        if (!isReady()) { raf = requestAnimationFrame(loop); return }
        const res = detectPose(v, now)

        c.width = v.videoWidth
        c.height = v.videoHeight
        g.clearRect(0, 0, c.width, c.height)

        if (res && res.keypoints.length) {
          const kps = res.keypoints

          // --- Side-profile guard: require one side to be clearly visible ---
          const leftSideOK =
            (kps[KP.LEFT_HIP].visibility ?? 0) > 0.6 &&
            (kps[KP.LEFT_KNEE].visibility ?? 0) > 0.6 &&
            (kps[KP.LEFT_ANKLE].visibility ?? 0) > 0.6
          const rightSideOK =
            (kps[KP.RIGHT_HIP].visibility ?? 0) > 0.6 &&
            (kps[KP.RIGHT_KNEE].visibility ?? 0) > 0.6 &&
            (kps[KP.RIGHT_ANKLE].visibility ?? 0) > 0.6
          const profileOK = leftSideOK || rightSideOK

          // Draw bones/joints regardless (helps user align)
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
          g.fillStyle = '#ffffff'
          kps.forEach((pt) => {
            if ((pt.visibility ?? 0) > 0.3) {
              g.beginPath()
              g.arc(pt.x * c.width, pt.y * c.height, 4, 0, Math.PI * 2)
              g.fill()
            }
          })

          // --- Angles (smoothed) ---
          const lKnee = angleABC(
            { x: kps[KP.LEFT_HIP].x, y: kps[KP.LEFT_HIP].y },
            { x: kps[KP.LEFT_KNEE].x, y: kps[KP.LEFT_KNEE].y },
            { x: kps[KP.LEFT_ANKLE].x, y: kps[KP.LEFT_ANKLE].y },
          )
          const rKnee = angleABC(
            { x: kps[KP.RIGHT_HIP].x, y: kps[KP.RIGHT_HIP].y },
            { x: kps[KP.RIGHT_KNEE].x, y: kps[KP.RIGHT_KNEE].y },
            { x: kps[KP.RIGHT_ANKLE].x, y: kps[KP.RIGHT_ANKLE].y },
          )
          const knee = (lKnee + rKnee) / 2
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

          // --- Depth with margin + temporal gating ---
          // Depth margin: require hip to be below knee by a bit (0.02 of image height)
          const depthMargin = 0.02
          const lDepthNow = kps[KP.LEFT_HIP].y > kps[KP.LEFT_KNEE].y + depthMargin
          const rDepthNow = kps[KP.RIGHT_HIP].y > kps[KP.RIGHT_KNEE].y + depthMargin
          const depthNow = lDepthNow && rDepthNow
          const depthOKSmoothed = depthGate.push(depthNow)

          // --- FSM and transitions ---
          const prevReps = fsm.reps
          const prevStateLocal = fsm.state
          fsm = stepFSM(fsm, hipC.y, depthOKSmoothed)
          setReps(fsm.reps)

          // New rep started → reset gate + rep cue memory
          if (prevStateLocal === 'lockout' && fsm.state === 'descent') {
            depthGate.reset()
            spokeCueTypeThisRep = null
          }

          // Speak ONLY on the transition into 'bottom' (reduces randomness)
          const justHitBottom = prevStateLocal !== 'bottom' && fsm.state === 'bottom'
          if (enabled && profileOK && justHitBottom) {
            const cues = checkRulesAtBottom({
              depthOK: depthOKSmoothed,
              trunkDeg: trunkSmoothed ?? trunk,
              trunkThreshold: 35,
            })
            const first = cues.find(c => c.type !== spokeCueTypeThisRep)
            if (first) {
              speak(first.message)
              spokeCueTypeThisRep = first.type
            }
          }

          // HUD
          g.fillStyle = profileOK ? '#ffffff' : '#ff7070'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fps)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeSmoothed || knee)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkSmoothed || trunk)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
          if (!profileOK) g.fillText('Tip: turn side-on to camera', 10, 100)
        }

        raf = requestAnimationFrame(loop)
      }

      raf = requestAnimationFrame(loop)
    }

    start().catch(console.error)
    return () => cancelAnimationFrame(raf)
  }, [enabled, speak])

  return (
    <div style={{ maxWidth: 420, marginInline: 'auto', position: 'relative' }}>
      {!enabled && (
        <button
          onClick={enable}
          style={{ padding: '8px 12px', borderRadius: 12, border: '1px solid #444', marginBottom: 12 }}
        >
          Enable Coaching Audio
        </button>
      )}
      {camError && (
        <div style={{ color: '#f33', marginBottom: 12, fontSize: 14 }}>{camError}</div>
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

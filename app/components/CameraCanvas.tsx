'use client'
import { useEffect, useRef, useState } from 'react'
import { initPose, detectPose, isReady } from '@/app/lib/pose/loader'
import { EDGES, KP } from '@/app/lib/pose/topology'
import { angleABC, trunkAngle, ema } from '@/app/lib/math/angles'
import { createFSM, stepFSM, type State } from '@/app/lib/logic/fsm'
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

  // NEW: camera + mirroring controls
  const [useFront, setUseFront] = useState(true) // front/selfie by default
  const mirror = useFront // mirror both video & canvas together when using front camera

  // TTS (1.2s cooldown inside the hook)
  const { enabled, enable, speak } = useTTS(1200)

  // Keep a handle to stop the previous stream when switching cameras
  const currentStream = useRef<MediaStream | null>(null)

  useEffect(() => {
    let raf = 0
    let last = performance.now()

    // smoothing accumulators
    let kneeSmoothed: number | null = null
    let trunkSmoothed: number | null = null

    // FSM + temporal gates
    let fsm = createFSM()
    const depthGate = new TemporalGate(6, 4) // require 4/6 depth frames at bottom
    let spokeCueTypeThisRep: null | 'depth' | 'trunk' | 'knee' = null

    async function start() {
      await initPose()

      // Stop any previous stream if switching cameras
      if (currentStream.current) {
        currentStream.current.getTracks().forEach(t => t.stop())
        currentStream.current = null
      }

      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCamError('Camera not available. Use localhost on desktop or HTTPS (Vercel/ngrok) on mobile.')
        return
      }

      // Prefer 1280x720 for better joint confidence; fall back gracefully
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: useFront ? 'user' : { exact: 'environment' as const },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch {
        // Some devices don’t support exact: 'environment' — fall back to default
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      }
      currentStream.current = stream

      const v = videoRef.current!
      const c = canvasRef.current!
      const g = c.getContext('2d')!
      v.srcObject = stream
      await v.play()

      const loop = () => {
        const now = performance.now()
        const dt = now - last
        const fpsNow = dt > 0 ? 1000 / dt : 0
        setFps(fpsNow)
        last = now

        if (!isReady()) {
          raf = requestAnimationFrame(loop)
          return
        }
        const res = detectPose(v, now)

        c.width = v.videoWidth
        c.height = v.videoHeight
        g.clearRect(0, 0, c.width, c.height)

        // === DRAW OVERLAY ===
        // NOTE: we are NOT drawing the video onto the canvas; the <video> sits behind.
        // If the <video> is mirrored via CSS, we also mirror the <canvas> element itself
        // (via CSS transform below) so overlay matches.
        if (res && res.keypoints.length) {
          const kps = res.keypoints
          const VIS = 0.2 // lower vis threshold a bit for stability

          // Side-profile guard: one side must be clearly visible
          const leftSideOK =
            (kps[KP.LEFT_HIP].visibility ?? 0) > 0.6 &&
            (kps[KP.LEFT_KNEE].visibility ?? 0) > 0.6 &&
            (kps[KP.LEFT_ANKLE].visibility ?? 0) > 0.6
          const rightSideOK =
            (kps[KP.RIGHT_HIP].visibility ?? 0) > 0.6 &&
            (kps[KP.RIGHT_KNEE].visibility ?? 0) > 0.6 &&
            (kps[KP.RIGHT_ANKLE].visibility ?? 0) > 0.6
          const profileOK = leftSideOK || rightSideOK

          // Bones
          g.lineWidth = 3
          g.globalAlpha = 0.9
          g.strokeStyle = '#ffffff'
          EDGES.forEach(([a, b]) => {
            const p = kps[a]; const q = kps[b]
            if ((p?.visibility ?? 0) > VIS && (q?.visibility ?? 0) > VIS) {
              g.beginPath()
              g.moveTo(p.x * c.width, p.y * c.height)
              g.lineTo(q.x * c.width, q.y * c.height)
              g.stroke()
            }
          })
          // Joints
          g.fillStyle = '#ffffff'
          kps.forEach((pt) => {
            if ((pt.visibility ?? 0) > VIS) {
              g.beginPath()
              g.arc(pt.x * c.width, pt.y * c.height, 4, 0, Math.PI * 2)
              g.fill()
            }
          })

          // Angles
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

          // Depth with margin + temporal gating
          const depthMargin = 0.02 // require hip below knee by a bit
          const lDepthNow = kps[KP.LEFT_HIP].y > kps[KP.LEFT_KNEE].y + depthMargin
          const rDepthNow = kps[KP.RIGHT_HIP].y > kps[KP.RIGHT_KNEE].y + depthMargin
          const depthNow = lDepthNow && rDepthNow
          const depthOKSmoothed = depthGate.push(depthNow)

          // FSM & transitions
          const prevState: State = fsm.state
          fsm = stepFSM(fsm, hipC.y, depthOKSmoothed)
          setReps(fsm.reps)
          if (prevState === 'lockout' && fsm.state === 'descent') {
            depthGate.reset()
            spokeCueTypeThisRep = null
          }

          // Speak ONLY when we just entered 'bottom'
          const justHitBottom = prevState !== 'bottom' && fsm.state === 'bottom'
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

          // Debug HUD on canvas
          g.fillStyle = profileOK ? '#ffffff' : '#ff7070'
          g.font = '16px system-ui'
          g.fillText(`FPS ${Math.round(fpsNow)}`, 10, 20)
          g.fillText(`Knee ${Math.round(kneeSmoothed || knee)}°`, 10, 40)
          g.fillText(`Trunk ${Math.round(trunkSmoothed || trunk)}°`, 10, 60)
          g.fillText(`Reps ${fsm.reps} | State ${fsm.state}`, 10, 80)
          if (!profileOK) g.fillText('Tip: side-on; show hips-knees-ankles', 10, 100)
        }

        raf = requestAnimationFrame(loop)
      }

      raf = requestAnimationFrame(loop)
    }

    start().catch(console.error)
    return () => {
      cancelAnimationFrame(raf)
      if (currentStream.current) currentStream.current.getTracks().forEach(t => t.stop())
    }
  // restart loop when TTS or camera selection changes
  }, [enabled, speak, useFront])

  return (
    <div style={{ maxWidth: 460, marginInline: 'auto' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12 }}>
        <button onClick={() => setUseFront(v => !v)} style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}>
          {useFront ? 'Switch to Rear Camera' : 'Switch to Front Camera'}
        </button>
        {!enabled && (
          <button onClick={enable} style={{ padding: '6px 10px', border: '1px solid #444', borderRadius: 10 }}>
            Enable Coaching Audio
          </button>
        )}
      </div>

      {camError && (
        <div style={{ color: '#f33', marginBottom: 12, fontSize: 14 }}>{camError}</div>
      )}

      {/* Mirror both video and canvas together when using front camera */}
      <div style={{
        position: 'relative',
        transform: mirror ? 'scaleX(-1)' as const : 'none'
      }}>
        <video ref={videoRef} className="w-full rounded-2xl" playsInline muted />
        <canvas ref={canvasRef} className="w-full h-full absolute inset-0 pointer-events-none" />
      </div>

      {/* simple label under the canvas (unmirrored) */}
      <div className="text-xs opacity-70 mt-2">
        FPS: {fps.toFixed(1)} | Reps: {reps} | Knee: {kneeDeg ?? '-'}° | Trunk: {trunkDeg ?? '-'}°
      </div>
    </div>
  )
}

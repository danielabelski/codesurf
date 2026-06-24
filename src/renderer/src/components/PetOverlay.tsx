// PetOverlay — floating animated pet mascot rendered via CSS spritesheet animation.
//
// The pet sprite is a 1536×1872 WebP/PNG spritesheet (8 cols × 9 rows of 192×208
// cells). We load it via the contex-file:// protocol and animate by shifting
// background-position through the frames of the active animation row.
//
// Animation rows react to agent activity events from the event bus:
//   - "running" when a chat/agent turn is active
//   - "idle" when waiting for input
//   - "failed" transient on tool failures
//   - "waving" on session start / turn completion
//
// The overlay is positioned bottom-right of the window, above the status bar,
// and can be dragged to reposition.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ATLAS,
  FRAME_DURATIONS,
  ROW_INDEX,
  type AnimationRow,
  type PetManifest,
} from '../../../shared/pet-types'

const SCHEME = 'contex-file'

/** Convert an absolute path to a contex-file:// URL the renderer can load. */
function toFileUrl(absPath: string): string {
  // contex-file:///absolute/path — three slashes, empty host, path starts at /
  return `${SCHEME}://${absPath}`
}

interface PetOverlayProps {
  slug: string
  scale: number
  onOpenPicker: () => void
}

interface DragState {
  startX: number
  startY: number
  originX: number
  originY: number
}

// Default position: bottom-right, above the status bar (~28px) and inset 16px
const DEFAULT_RIGHT = 16
const DEFAULT_BOTTOM = 36

// Session start: show waving for 2s, then settle to idle
const TRANSIENT_MS = 2000

export function PetOverlay({ slug, scale, onOpenPicker }: PetOverlayProps): JSX.Element | null {
  const [manifest, setManifest] = useState<PetManifest | null>(null)
  const [row, setRow] = useState<AnimationRow>('idle')
  const [frameIndex, setFrameIndex] = useState(0)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const baseRowRef = useRef<AnimationRow>('idle')

  // Load manifest when slug changes
  useEffect(() => {
    if (!slug) {
      setManifest(null)
      return
    }
    let cancelled = false
    window.electron.pets.getManifest(slug).then((m) => {
      if (!cancelled) setManifest(m)
    })
    return () => {
      cancelled = true
    }
  }, [slug])

  // Animation frame cycling — uses requestAnimationFrame to advance frames
  // at the per-row cadence defined in FRAME_DURATIONS.
  useEffect(() => {
    if (!manifest) return
    const durations = FRAME_DURATIONS[row]
    if (!durations || durations.length === 0) return

    let frameIdx = 0
    let lastTime = performance.now()
    let rafId: number

    const tick = (now: number) => {
      const elapsed = (now - lastTime) / 1000
      const currentDuration = durations[frameIdx]
      if (currentDuration !== undefined && elapsed >= currentDuration) {
        frameIdx = (frameIdx + 1) % durations.length
        setFrameIndex(frameIdx)
        lastTime = now
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [manifest, row])

  // Agent activity → animation row mapping via event bus.
  // Subscribes to chat tile events to drive pet state transitions.
  useEffect(() => {
    const subscriberId = `pet-overlay-${slug}`

    const setBaseRow = (next: AnimationRow) => {
      baseRowRef.current = next
      setRow(next)
    }

    const showTransient = (next: AnimationRow, durationMs: number) => {
      setRow(next)
      if (transientTimerRef.current) clearTimeout(transientTimerRef.current)
      transientTimerRef.current = setTimeout(() => {
        transientTimerRef.current = null
        setRow(baseRowRef.current)
      }, durationMs)
    }

    const subscriptions: Array<() => void> = []

    // Chat streaming events → running state
    const unsubStreaming = window.electron.bus?.subscribe(
      'chat:streaming',
      subscriberId,
      () => {
        setBaseRow('running')
      },
    )
    if (unsubStreaming) subscriptions.push(unsubStreaming)

    const unsubDone = window.electron.bus?.subscribe(
      'chat:done',
      subscriberId,
      () => {
        setBaseRow('idle')
        showTransient('waving', TRANSIENT_MS)
      },
    )
    if (unsubDone) subscriptions.push(unsubDone)

    const unsubError = window.electron.bus?.subscribe(
      'chat:error',
      subscriberId,
      () => {
        showTransient('failed', TRANSIENT_MS)
      },
    )
    if (unsubError) subscriptions.push(unsubError)

    const unsubTool = window.electron.bus?.subscribe(
      'tool:execute',
      subscriberId,
      () => {
        // Brief "review" flash when a tool starts
        if (baseRowRef.current === 'running') {
          showTransient('review', 800)
        }
      },
    )
    if (unsubTool) subscriptions.push(unsubTool)

    return () => {
      for (const unsub of subscriptions) {
        try {
          unsub()
        } catch {
          // ignore
        }
      }
      if (transientTimerRef.current) {
        clearTimeout(transientTimerRef.current)
        transientTimerRef.current = null
      }
    }
  }, [slug])

  // Dragging
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!position) return
      e.preventDefault()
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: position.x,
        originY: position.y,
      }
      setDragging(true)
    },
    [position],
  )

  useEffect(() => {
    if (!dragging) return
    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      setPosition({
        x: dragRef.current.originX + dx,
        y: dragRef.current.originY + dy,
      })
    }
    const handleUp = () => {
      setDragging(false)
      dragRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [dragging])

  // Compute sprite dimensions from scale
  const cellW = ATLAS.cellWidth
  const cellH = ATLAS.cellHeight
  const displayW = Math.round(cellW * scale)
  const displayH = Math.round(cellH * scale)

  // Background position: negative offset into the spritesheet
  const rowIndex = ROW_INDEX[row] ?? 0
  const bgX = -(frameIndex * cellW)
  const bgY = -(rowIndex * cellH)

  // Position: default bottom-right, or user-dragged position
  const style: React.CSSProperties = useMemo(() => {
    if (position) {
      return {
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${displayW}px`,
        height: `${displayH}px`,
        zIndex: 99999,
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        pointerEvents: 'auto',
      }
    }
    return {
      position: 'fixed',
      right: `${DEFAULT_RIGHT}px`,
      bottom: `${DEFAULT_BOTTOM}px`,
      width: `${displayW}px`,
      height: `${displayH}px`,
      zIndex: 99999,
      cursor: 'grab',
      userSelect: 'none',
      pointerEvents: 'auto',
    }
  }, [position, displayW, displayH, dragging])

  if (!manifest) return null

  const spritesheetUrl = toFileUrl(manifest.spritesheetPath)

  return (
    <div
      style={style}
      onMouseDown={handleMouseDown}
      onDoubleClick={onOpenPicker}
      title={`${manifest.displayName} — double-click to change pet`}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundImage: `url(${spritesheetUrl})`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: `${bgX}px ${bgY}px`,
          backgroundSize: `${cellW * ATLAS.columns}px ${cellH * ATLAS.rows}px`,
          imageRendering: 'pixelated',
          // Subtle drop shadow for depth
          filter: 'drop-shadow(2px 4px 6px rgba(0,0,0,0.4))',
        }}
      />
    </div>
  )
}

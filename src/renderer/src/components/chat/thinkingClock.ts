/**
 * Shared thinking-chip clock.
 *
 * Pure elapsed helpers are unit-testable without React. React chips subscribe
 * via `useSharedThinkingClock` so many active thinking chips share one
 * setInterval instead of N independent 250ms timers.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

export const THINKING_CLOCK_TICK_MS = 250

/** Whole seconds elapsed from start to now (floor). */
export function computeThinkingElapsedSec(startMs: number, nowMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return 0
  return Math.max(0, Math.floor((nowMs - startMs) / 1000))
}

/**
 * Final display seconds when thinking completes.
 * Uses at least 1s so a sub-second think still shows "1s".
 */
export function finalizeThinkingElapsedSec(startMs: number, endMs: number): number {
  return Math.max(1, Math.round(Math.max(0, endMs - startMs) / 1000))
}

/** Display seconds: frozen final value if done, else live elapsed from start. */
export function resolveThinkingDisplayedElapsed(
  startMs: number | null,
  nowMs: number,
  done: boolean,
  finalElapsedSec: number | null,
): number {
  if (done && finalElapsedSec != null) return finalElapsedSec
  if (startMs == null) return 0
  if (done) return finalizeThinkingElapsedSec(startMs, nowMs)
  return computeThinkingElapsedSec(startMs, nowMs)
}

// ─── Shared ticking clock (one interval for all active thinking chips) ───────

type Listener = () => void

let nowMs = Date.now()
let subscriberCount = 0
let intervalId: ReturnType<typeof setInterval> | null = null
const listeners = new Set<Listener>()

function emit(): void {
  nowMs = Date.now()
  for (const l of listeners) {
    try { l() } catch { /* ignore */ }
  }
}

function ensureInterval(): void {
  if (intervalId != null || subscriberCount === 0) return
  intervalId = setInterval(emit, THINKING_CLOCK_TICK_MS)
}

function maybeClearInterval(): void {
  if (subscriberCount > 0 || intervalId == null) return
  clearInterval(intervalId)
  intervalId = null
}

function subscribeSharedClock(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSharedNowMs(): number {
  return nowMs
}

/**
 * Subscribe to the shared thinking clock while `active` is true.
 * Returns current wall-clock ms (updated on the shared tick).
 * Inactive chips do not hold the global interval open.
 */
export function useSharedThinkingClock(active: boolean): number {
  const [enabled, setEnabled] = useState(active)
  // Keep enabled in sync without re-subscribing thrash mid-tick
  useEffect(() => {
    setEnabled(active)
  }, [active])

  useEffect(() => {
    if (!enabled) return
    subscriberCount += 1
    ensureInterval()
    return () => {
      subscriberCount -= 1
      maybeClearInterval()
    }
  }, [enabled])

  return useSyncExternalStore(
    subscribeSharedClock,
    getSharedNowMs,
    getSharedNowMs,
  )
}

/** Test helpers */
export function getThinkingClockSubscriberCountForTests(): number {
  return subscriberCount
}

export function isThinkingClockIntervalActiveForTests(): boolean {
  return intervalId != null
}

export function resetThinkingClockForTests(): void {
  if (intervalId != null) {
    clearInterval(intervalId)
    intervalId = null
  }
  subscriberCount = 0
  listeners.clear()
  nowMs = Date.now()
}

/**
 * useSpeechToText — wraps the browser Web Speech API for chat dictation.
 *
 * Behavior contract:
 *   • `start()`         — begins listening. Idempotent (no-op if already running).
 *   • `stop()`          — ends listening. Final transcript is delivered via onTranscript.
 *   • `toggle()`        — start if idle, stop if recording. For click handlers.
 *   • `isRecording`     — true while the recognizer is open.
 *   • `isSupported`     — true if the browser exposes SpeechRecognition.
 *   • `error`           — last error code (null if no error).
 *
 * Caveat (Electron):
 *   Electron's bundled Chromium typically does NOT include Google's STT
 *   service. `webkitSpeechRecognition` exists but will likely emit a
 *   `'service-not-allowed'` or `'network'` error on .start(). When that
 *   happens we surface the error code via the `error` state so the UI can
 *   show a clear "voice unavailable in this build" message rather than
 *   silently failing.
 *
 *   To get working voice in Electron you eventually need a real backend
 *   (OpenAI Whisper API, local whisper.cpp, macOS dictation IPC). The
 *   public interface of this hook is engine-agnostic, so swapping the
 *   internals later doesn't require any changes to ChatTile.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseSpeechToTextOptions {
  /** Called with the final transcript when recording stops cleanly. */
  onTranscript: (text: string) => void
  /** Called with an interim transcript so the caller can preview it. Optional. */
  onInterim?: (text: string) => void
  /** BCP-47 language tag, e.g. 'en-US', 'en-GB'. Defaults to browser locale. */
  lang?: string
}

interface UseSpeechToTextResult {
  isRecording: boolean
  isSupported: boolean
  error: string | null
  start: () => void
  stop: () => void
  toggle: () => void
}

// Chrome/Electron use the prefixed name; standards-track Firefox uses bare.
function getSpeechRecognitionCtor(): (new () => any) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => any
    webkitSpeechRecognition?: new () => any
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useSpeechToText({ onTranscript, onInterim, lang }: UseSpeechToTextOptions): UseSpeechToTextResult {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognizerRef = useRef<any>(null)
  const finalTranscriptRef = useRef<string>('')
  const onTranscriptRef = useRef(onTranscript)
  const onInterimRef = useRef(onInterim)
  onTranscriptRef.current = onTranscript
  onInterimRef.current = onInterim

  const Ctor = getSpeechRecognitionCtor()
  const isSupported = Ctor !== null

  const start = useCallback(() => {
    if (recognizerRef.current) return
    const Klass = getSpeechRecognitionCtor()
    if (!Klass) {
      setError('not-supported')
      return
    }
    try {
      const r = new Klass()
      r.continuous = true        // keep listening until .stop() — important for press-and-hold
      r.interimResults = true    // emit partial transcripts so the user sees progress
      if (lang) r.lang = lang

      finalTranscriptRef.current = ''
      setError(null)

      r.onresult = (event: any) => {
        let interim = ''
        let finalChunk = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const text = result[0]?.transcript ?? ''
          if (result.isFinal) finalChunk += text
          else interim += text
        }
        if (finalChunk) finalTranscriptRef.current += finalChunk
        if (interim && onInterimRef.current) onInterimRef.current(interim)
      }

      r.onerror = (event: any) => {
        // Common codes: 'no-speech', 'network', 'service-not-allowed',
        // 'not-allowed' (mic permission), 'aborted'.
        setError(typeof event?.error === 'string' ? event.error : 'unknown')
      }

      r.onend = () => {
        recognizerRef.current = null
        setIsRecording(false)
        const finalText = finalTranscriptRef.current.trim()
        if (finalText) onTranscriptRef.current(finalText)
        finalTranscriptRef.current = ''
      }

      recognizerRef.current = r
      r.start()
      setIsRecording(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'start-failed')
      recognizerRef.current = null
    }
  }, [lang])

  const stop = useCallback(() => {
    const r = recognizerRef.current
    if (!r) return
    try { r.stop() } catch { /* ignore — onend will clean up */ }
  }, [])

  const toggle = useCallback(() => {
    if (recognizerRef.current) stop()
    else start()
  }, [start, stop])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const r = recognizerRef.current
      if (r) {
        try { r.abort() } catch { /* ignore */ }
        recognizerRef.current = null
      }
    }
  }, [])

  return { isRecording, isSupported, error, start, stop, toggle }
}

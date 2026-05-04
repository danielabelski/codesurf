import { useEffect, useState } from 'react'
import { onContext, callHost, subscribe, type BridgeContext } from '@contex/chat-bridge'
import { Thread } from './Thread'
import { ContexRuntimeProvider } from './runtime/ContexRuntimeProvider'

export function ChatApp() {
  const [ctx, setCtx] = useState<BridgeContext | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'connected' | 'standalone'>('idle')

  useEffect(() => {
    // If no host parent answers within 1.5s assume standalone preview.
    const timer = window.setTimeout(() => {
      setBridgeStatus(prev => (prev === 'idle' ? 'standalone' : prev))
    }, 1500)

    const unsubscribe = onContext((next) => {
      window.clearTimeout(timer)
      setCtx(next)
      setBridgeStatus('connected')
      // Apply theme/font tokens from the host onto :root so all child
      // components using shadcn CSS vars inherit the host's palette.
      const root = document.documentElement
      for (const [key, value] of Object.entries(next.theme ?? {})) {
        root.style.setProperty(key, String(value))
      }
      for (const [key, value] of Object.entries(next.fonts ?? {})) {
        root.style.setProperty(key, String(value))
      }
    })

    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return (
    <ContexRuntimeProvider context={ctx}>
      <div className="flex h-full flex-col">
        <Header status={bridgeStatus} ctx={ctx} />
        <div className="flex-1 min-h-0">
          <Thread />
        </div>
      </div>
    </ContexRuntimeProvider>
  )
}

function Header({ status, ctx }: { status: 'idle' | 'connected' | 'standalone'; ctx: BridgeContext | null }) {
  const dotColor = status === 'connected' ? '#10b981' : status === 'standalone' ? '#f59e0b' : '#6b7280'
  const label = status === 'connected'
    ? `${ctx?.tileId?.slice(0, 8) ?? 'tile'} · ${ctx?.workspaceDir ?? ''}`
    : status === 'standalone'
      ? 'Standalone preview (no host)'
      : 'Connecting…'
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: 'var(--color-muted-foreground)' }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: dotColor }} />
      <span className="truncate">{label}</span>
    </div>
  )
}

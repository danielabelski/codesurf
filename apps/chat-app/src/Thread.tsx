import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  AuiIf,
} from '@assistant-ui/react'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'

export function Thread() {
  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-background text-sm"
      style={{ '--thread-max-width': '48rem' } as React.CSSProperties}
    >
      <ThreadPrimitive.Viewport className="relative flex flex-1 flex-col overflow-y-auto px-4 pt-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <Welcome />
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage }}
        />

        <ThreadPrimitive.ViewportFooter
          className="sticky bottom-0 mx-auto mt-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 pb-4"
          style={{ background: 'var(--color-background)' }}
        >
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function Welcome() {
  return (
    <div className="mx-auto my-auto flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col items-center justify-center px-8 text-center">
      <div className="text-2xl font-semibold" style={{ color: 'var(--color-foreground)' }}>
        Contex chat
      </div>
      <div className="text-2xl" style={{ color: 'var(--color-muted-foreground)' }}>
        say something to start
      </div>
    </div>
  )
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone
        className="flex w-full flex-col rounded-3xl border px-1 pt-2 outline-none transition-shadow data-[dragging=true]:border-dashed"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-background)',
        }}
      >
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="mb-1 max-h-32 min-h-14 w-full resize-none bg-transparent px-4 pt-2 pb-3 text-sm outline-none"
          style={{ color: 'var(--color-foreground)' }}
          rows={1}
          autoFocus
        />
        <ComposerActions />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  )
}

function ComposerActions() {
  return (
    <div className="relative mx-2 mb-2 flex items-center justify-end">
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <button
            type="submit"
            className="flex size-8 items-center justify-center rounded-full"
            style={{ background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' }}
            aria-label="Send message"
          >
            <ArrowUpIcon className="size-4" />
          </button>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full"
            style={{ background: 'var(--color-foreground)', color: 'var(--color-background)' }}
            aria-label="Stop generating"
          >
            <SquareIcon className="size-3 fill-current" />
          </button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      className="mx-auto grid w-full max-w-[var(--thread-max-width)] grid-cols-[minmax(72px,1fr)_auto] gap-y-2 px-2 py-3"
      data-role="user"
    >
      <div className="col-start-2 min-w-0">
        <div
          className="rounded-3xl px-4 py-2.5 text-sm break-words"
          style={{ background: 'var(--color-muted)', color: 'var(--color-foreground)' }}
        >
          <MessagePrimitive.Parts />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className="relative mx-auto w-full max-w-[var(--thread-max-width)] py-3"
      data-role="assistant"
    >
      <div className="px-2 leading-relaxed text-sm" style={{ color: 'var(--color-foreground)' }}>
        <MessagePrimitive.Parts />
        <AuiIf condition={(s) => s.thread.isRunning && s.message.content.length === 0}>
          <span style={{ color: 'var(--color-muted-foreground)' }}>thinking…</span>
        </AuiIf>
      </div>
    </MessagePrimitive.Root>
  )
}

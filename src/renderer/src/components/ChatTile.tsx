import React, { useState, useEffect, useRef, useCallback } from 'react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
}

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
}

export function ChatTile({ tileId, workspaceId: _workspaceId, workspaceDir: _workspaceDir, width: _width, height: _height }: Props): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [provider, setProvider] = useState<'claude' | 'openai' | 'ollama'>('claude')
  const [model, setModel] = useState('claude-sonnet-4-5-20250514')
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Model defaults per provider
  const modelDefaults: Record<string, string> = {
    claude: 'claude-sonnet-4-5-20250514',
    openai: 'gpt-4o',
    ollama: 'llama3'
  }

  const handleProviderChange = useCallback((newProvider: 'claude' | 'openai' | 'ollama') => {
    setProvider(newProvider)
    setModel(modelDefaults[newProvider])
  }, [])

  // Auto-scroll on new messages (no scrollIntoView — causes canvas shift)
  useEffect(() => {
    const el = messagesContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Stream listener
  useEffect(() => {
    const cleanup = window.electron?.stream?.onChunk((event: any) => {
      if (event.cardId !== tileId) return

      if (event.type === 'text' && event.text) {
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.isStreaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.text }]
          }
          return prev
        })
      }

      if (event.type === 'done') {
        setMessages(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m))
        setIsStreaming(false)

        // Publish completion to bus
        window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
          message: 'Assistant responded',
          role: 'assistant'
        })
      }

      if (event.type === 'error') {
        setMessages(prev => prev.map(m =>
          m.isStreaming ? { ...m, content: `Error: ${event.error}`, isStreaming: false } : m
        ))
        setIsStreaming(false)
      }
    })

    return cleanup
  }, [tileId])

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming) return

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: Date.now()
    }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsStreaming(true)

    // Publish to bus
    window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
      message: `User: ${userMsg.content.slice(0, 100)}`,
      role: 'user'
    })

    // Create placeholder for assistant response
    const assistantId = `msg-${Date.now() + 1}`
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true
    }])

    try {
      await window.electron?.stream?.start({
        cardId: tileId,
        agentId: provider,
        url: '',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
        })
      })
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, content: `Error: ${err}`, isStreaming: false }
          : m
      ))
      setIsStreaming(false)
    }
  }, [input, isStreaming, messages, tileId, provider, model])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  // Auto-resize textarea up to 4 lines
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      const maxHeight = 4 * 20 // ~4 lines
      ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`
    }
  }, [])

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#111',
      color: '#d4d4d4',
      fontFamily: 'inherit',
      fontSize: 13
    }}>
      {/* Header bar */}
      <div style={{
        height: 32,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 8px',
        background: '#161616',
        borderBottom: '1px solid #2d2d2d'
      }}>
        <select
          value={provider}
          onChange={e => handleProviderChange(e.target.value as 'claude' | 'openai' | 'ollama')}
          style={{
            background: '#252525',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: 4,
            fontSize: 11,
            padding: '2px 6px',
            outline: 'none',
            cursor: 'pointer'
          }}
        >
          <option value="claude">Claude</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Ollama</option>
        </select>
        <span style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model}
        </span>
      </div>

      {/* Messages area */}
      <div
        ref={messagesContainerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 0
        }}
      >
        {messages.length === 0 && (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#555',
            fontSize: 12
          }}>
            Send a message to start
          </div>
        )}
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start'
            }}
          >
            <div style={{
              fontSize: 10,
              color: '#666',
              marginBottom: 2,
              padding: '0 4px'
            }}>
              {msg.role === 'user' ? 'You' : 'Assistant'} {formatTime(msg.timestamp)}
            </div>
            <div style={{
              background: msg.role === 'user' ? '#1a3a5c' : '#1e1e1e',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: '#d4d4d4'
            }}>
              {msg.content}
              {msg.isStreaming && (
                <span style={{ color: '#888', marginLeft: 2 }}>|</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input area */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        gap: 6,
        padding: 8,
        background: '#1a1a1a',
        borderTop: '1px solid #2d2d2d',
        alignItems: 'flex-end'
      }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          placeholder="Type a message..."
          rows={1}
          style={{
            flex: 1,
            background: '#252525',
            color: '#d4d4d4',
            border: '1px solid #333',
            borderRadius: 4,
            padding: '6px 8px',
            fontSize: 13,
            fontFamily: 'inherit',
            lineHeight: 1.4,
            resize: 'none',
            outline: 'none',
            overflow: 'hidden',
            minHeight: 28,
            opacity: isStreaming ? 0.5 : 1
          }}
        />
        <button
          onClick={sendMessage}
          disabled={isStreaming || !input.trim()}
          style={{
            background: isStreaming || !input.trim() ? '#252525' : '#2a5a8a',
            color: isStreaming || !input.trim() ? '#555' : '#ccc',
            border: '1px solid #333',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: isStreaming || !input.trim() ? 'default' : 'pointer',
            fontFamily: 'inherit',
            flexShrink: 0,
            height: 28,
            display: 'flex',
            alignItems: 'center'
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}

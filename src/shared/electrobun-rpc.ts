export type CodeSurfElectrobunInvokeRequest = {
  channel: string
  args?: unknown[]
}

export type CodeSurfElectrobunEventMessage = {
  channel: string
  payload?: unknown
}

export type CodeSurfElectrobunLogMessage = {
  level?: 'debug' | 'info' | 'warn' | 'error'
  message: string
  detail?: unknown
}

export type CodeSurfElectrobunBridgeReadyMessage = {
  platform: string
  hasElectronFacade: boolean
  hasElectrobunWebviewTag?: boolean
  userAgent?: string
}

export type CodeSurfRPCSide<Requests extends Record<string, unknown>, Messages extends Record<string, unknown>> = {
  requests: Requests
  messages: Messages
}

export type CodeSurfElectrobunRPC = {
  bun: CodeSurfRPCSide<{
    invoke: {
      params: CodeSurfElectrobunInvokeRequest
      response: unknown
    }
  }, {
    log: CodeSurfElectrobunLogMessage
    bridgeReady: CodeSurfElectrobunBridgeReadyMessage
  }>
  webview: CodeSurfRPCSide<{
    ping: {
      params: undefined
      response: true
    }
  }, {
    event: CodeSurfElectrobunEventMessage
  }>
}

export const SENSITIVE_MEDIA_CAPABILITIES = [
  'microphone',
  'camera',
  'display-capture',
] as const

export type SensitiveMediaCapability = typeof SENSITIVE_MEDIA_CAPABILITIES[number]

export interface DeclaredSensitiveMedia {
  readonly capabilities: SensitiveMediaCapability[]
  readonly reasons: Readonly<
    Partial<Record<SensitiveMediaCapability, string>>
  >
}

export const EXTENSION_MEDIA_DIALOG_TEXT_BYTES = Object.freeze({
  detail: 512,
  extensionId: 128,
  extensionName: 96,
  message: 192,
  reason: 256,
  sourceLabel: 96,
})

export interface SafeExtensionMediaAttribution {
  readonly id: string
  readonly name: string
  readonly reason?: string
}

const textEncoder = new TextEncoder()
const UNSAFE_CONTROL = /\p{Cc}/gu
const UNSAFE_BIDI_FORMATTING = /\p{Bidi_Control}/gu

function truncateUtf8(value: string, maxBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value
  const ellipsis = '…'
  const contentBudget = maxBytes - textEncoder.encode(ellipsis).byteLength
  let result = ''
  let used = 0
  for (const character of value) {
    const bytes = textEncoder.encode(character).byteLength
    if (used + bytes > contentBudget) break
    result += character
    used += bytes
  }
  return `${result.trimEnd()}${ellipsis}`
}

export function sanitizeExtensionMediaDialogText(
  value: unknown,
  fallback: string,
  maxBytes: number,
): string {
  const normalize = (candidate: unknown): string => {
    if (typeof candidate !== 'string') return ''
    return candidate
      .replace(UNSAFE_CONTROL, ' ')
      .replace(UNSAFE_BIDI_FORMATTING, '')
      .replace(/\s+/gu, ' ')
      .trim()
  }
  const normalized = normalize(value) || normalize(fallback)
  return truncateUtf8(normalized, maxBytes)
}

export function getSafeExtensionMediaAttribution(
  extensionId: unknown,
  extensionName: unknown,
  reason?: unknown,
): SafeExtensionMediaAttribution {
  const id = sanitizeExtensionMediaDialogText(
    extensionId,
    'unknown-extension',
    EXTENSION_MEDIA_DIALOG_TEXT_BYTES.extensionId,
  )
  const name = sanitizeExtensionMediaDialogText(
    extensionName,
    id,
    EXTENSION_MEDIA_DIALOG_TEXT_BYTES.extensionName,
  )
  const safeReason = sanitizeExtensionMediaDialogText(
    reason,
    '',
    EXTENSION_MEDIA_DIALOG_TEXT_BYTES.reason,
  )
  return {
    id,
    name,
    ...(safeReason ? { reason: safeReason } : {}),
  }
}

export function isExtensionMediaIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

export function isSensitiveMediaCapability(value: unknown): value is SensitiveMediaCapability {
  return typeof value === 'string'
    && SENSITIVE_MEDIA_CAPABILITIES.includes(value as SensitiveMediaCapability)
}

export function getDeclaredSensitiveMediaCapabilities(
  capabilities: readonly {
    readonly name: string
    readonly reason?: string
  }[] | undefined,
): SensitiveMediaCapability[] {
  return getDeclaredSensitiveMediaDeclaration(capabilities).capabilities
}

export function getDeclaredSensitiveMediaDeclaration(
  capabilities: readonly {
    readonly name: string
    readonly reason?: string
  }[] | undefined,
): DeclaredSensitiveMedia {
  const declared = new Set<SensitiveMediaCapability>()
  const reasons: Partial<Record<SensitiveMediaCapability, string>> = {}
  for (const capability of capabilities ?? []) {
    if (!isSensitiveMediaCapability(capability.name) || declared.has(capability.name)) {
      continue
    }
    declared.add(capability.name)
    if (typeof capability.reason === 'string') {
      reasons[capability.name] = capability.reason
    }
  }
  return {
    capabilities: SENSITIVE_MEDIA_CAPABILITIES.filter(capability => {
      return declared.has(capability)
    }),
    reasons: Object.freeze(reasons),
  }
}

export function getExtensionIframeAllow(
  capabilities: readonly SensitiveMediaCapability[] | undefined,
): string {
  const declared = new Set(capabilities ?? [])
  return [
    'autoplay',
    ...SENSITIVE_MEDIA_CAPABILITIES.filter(capability => declared.has(capability)),
  ].join('; ')
}

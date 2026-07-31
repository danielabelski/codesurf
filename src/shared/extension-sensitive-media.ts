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

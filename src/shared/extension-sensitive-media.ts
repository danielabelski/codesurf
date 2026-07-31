export const SENSITIVE_MEDIA_CAPABILITIES = [
  'microphone',
  'camera',
  'display-capture',
] as const

export type SensitiveMediaCapability = typeof SENSITIVE_MEDIA_CAPABILITIES[number]

export function isExtensionMediaIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

export function isSensitiveMediaCapability(value: unknown): value is SensitiveMediaCapability {
  return typeof value === 'string'
    && SENSITIVE_MEDIA_CAPABILITIES.includes(value as SensitiveMediaCapability)
}

export function getDeclaredSensitiveMediaCapabilities(
  capabilities: readonly { readonly name: string }[] | undefined,
): SensitiveMediaCapability[] {
  const declared = new Set(
    (capabilities ?? [])
      .map(capability => capability.name)
      .filter(isSensitiveMediaCapability),
  )
  return SENSITIVE_MEDIA_CAPABILITIES.filter(capability => declared.has(capability))
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

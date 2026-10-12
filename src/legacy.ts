import type { Span } from '@opentelemetry/api'
import type { NodeType } from './types.js'

// 30-day window: dual-write ends 2026-09-18.
export const LEGACY_EXPIRY = '2026-09-18'

const MODEL_KEY_RENAMES: Record<string, string> = {
  ttft_ms: 'time_to_first_token_ms',
}

export function writeLegacyAttributes(
  span: Span,
  type: NodeType,
  name: string,
  key: string,
  value: unknown,
): void {
  let legacyKey: string
  if (type === 'tool') {
    legacyKey = `app.${name}.${key}`
  } else if (type === 'model') {
    const renamedKey = MODEL_KEY_RENAMES[key] ?? key
    legacyKey = `app.${renamedKey}`
  } else {
    return
  }
  span.setAttribute(legacyKey, value as Parameters<Span['setAttribute']>[1])
}

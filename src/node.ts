import { trace } from '@opentelemetry/api'
import type { AttributeValue } from '@opentelemetry/api'
import type { NodeType, NodeHandle } from './types.js'
import { writeLegacyAttributes } from './legacy.js'

export function createNodeHandle(type: NodeType, name: string): NodeHandle {
  const prefix = `app.${type}.${name}.`

  return {
    set(attrs: Record<string, AttributeValue>) {
      const span = trace.getActiveSpan()
      if (!span) return
      for (const [key, value] of Object.entries(attrs)) {
        span.setAttribute(`${prefix}${key}`, value)
        writeLegacyAttributes(span, type, name, key, value)
      }
    },
  }
}

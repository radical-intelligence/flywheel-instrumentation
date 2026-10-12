import { trace } from '@opentelemetry/api'
import type { AttributeValue } from '@opentelemetry/api'
import type { NodeType, NodeHandle, NodeSchema } from './types.js'
import { checkValue, renameActive, reportInvalid, schemaMaxLength } from './schema.js'
import type { WriteSettings } from './schema.js'

export function createNodeHandle(type: NodeType, name: string): NodeHandle {
  const prefix = `app.${type}.${name}.`

  return {
    set(attrs: Record<string, AttributeValue>) {
      const span = trace.getActiveSpan()
      if (!span) return
      for (const [key, value] of Object.entries(attrs)) {
        span.setAttribute(`${prefix}${key}`, value)
      }
    },
  }
}

/** A handle that writes declared keys only, each checked against its spec. */
export function createSchemaNodeHandle(
  type: NodeType,
  name: string,
  schema: NodeSchema,
  settings: WriteSettings,
): NodeHandle<Record<string, unknown>> {
  const prefix = `app.${type}.${name}.`
  const maxLength = schemaMaxLength(schema)

  return {
    set(attrs: Record<string, unknown>) {
      const span = trace.getActiveSpan()
      if (!span) return
      for (const [key, raw] of Object.entries(attrs)) {
        if (raw === undefined) continue
        const attribute = `${prefix}${key}`
        const spec = Object.hasOwn(schema.attributes, key) ? schema.attributes[key] : undefined
        if (!spec) {
          reportInvalid(span, settings, attribute, 'key not declared in the schema')
          continue
        }
        const checked = checkValue(spec, raw, maxLength)
        if (typeof checked === 'string') {
          reportInvalid(span, settings, attribute, checked)
          continue
        }
        const keys = [key]
        if (spec.renamedFrom && renameActive(spec.renamedFrom.until, settings.now())) {
          keys.push(spec.renamedFrom.from)
        }
        for (const k of keys) {
          span.setAttribute(`${prefix}${k}`, checked.value)
          if (checked.truncated) span.setAttribute(`${prefix}${k}.truncated`, true)
        }
      }
    },
  }
}

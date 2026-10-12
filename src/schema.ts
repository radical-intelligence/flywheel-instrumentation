import type { AttributeValue, Span } from '@opentelemetry/api'
import type { AttributeSpec, NodeSchema, InitOptions } from './types.js'

/** The string length limit when neither the key nor the schema sets one. */
export const DEFAULT_MAX_LENGTH = 1024

/** The span attribute that names each key whose write was dropped. */
export const ATTRIBUTE_ERROR = 'flywheel.attribute_error'

export interface WriteSettings {
  strict: boolean
  now: () => number
}

export function writeSettings(options?: InitOptions): WriteSettings {
  return {
    strict: options?.strict ?? false,
    now: options?.now ?? Date.now,
  }
}

// Spans expose no attribute reads, so the dropped keys of each span are kept here.
const errorsBySpan = new WeakMap<Span, string[]>()

/**
 * Records a dropped write on the span. In strict mode it throws as well.
 */
export function reportInvalid(span: Span, settings: WriteSettings, attribute: string, reason: string): void {
  const errors = errorsBySpan.get(span) ?? []
  if (!errors.includes(attribute)) errors.push(attribute)
  errorsBySpan.set(span, errors)
  span.setAttribute(ATTRIBUTE_ERROR, [...errors])
  if (settings.strict) throw new TypeError(`flywheel: dropped ${attribute}: ${reason}`)
}

export interface CheckedValue {
  value: AttributeValue
  truncated: boolean
}

/** Returns the value to write, or a reason when the value does not match the spec. */
export function checkValue(spec: AttributeSpec, value: unknown, maxLength: number): CheckedValue | string {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return 'expected a string'
      return cut(value, spec.maxLength ?? maxLength)
    case 'string[]': {
      if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return 'expected an array of strings'
      const limit = spec.maxLength ?? maxLength
      const items = value.map(v => cut(v, limit))
      return { value: items.map(i => i.value as string), truncated: items.some(i => i.truncated) }
    }
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) return `expected one of ${spec.values.join(', ')}`
      return { value, truncated: false }
    case 'count':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 'expected a non-negative integer'
      return { value, truncated: false }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a finite number'
      return { value, truncated: false }
    case 'boolean':
      if (typeof value !== 'boolean') return 'expected a boolean'
      return { value, truncated: false }
  }
}

function cut(value: string, limit: number): CheckedValue {
  if (value.length <= limit) return { value, truncated: false }
  return { value: value.slice(0, limit), truncated: true }
}

/** True while the old name of a rename is still written. It stops at 00:00 UTC on the expiry date. */
export function renameActive(until: string, now: number): boolean {
  const end = Date.parse(`${until}T00:00:00Z`)
  return Number.isFinite(end) && now < end
}

export function schemaMaxLength(schema: NodeSchema): number {
  return schema.maxLength ?? DEFAULT_MAX_LENGTH
}

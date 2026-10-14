/**
 * The types of a conformance scenario. `scenario.schema.json` is the
 * language-neutral form of the same vocabulary, and `AGENTS.md` in this
 * folder says what each step does.
 */

/** A JSON value. `{ "$repeat": ... }` and `{ "$number": ... }` stand for values that JSON cannot write, or writes only at length. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value }

export interface Setup {
  /** The start of the scenario clock, as an ISO 8601 UTC time. */
  clock: string
  tracerProvider: boolean
  loggerProvider: boolean
  /** The span attribute count limit of the SDK tracer provider. */
  attributeCountLimit: number
  sampler: 'always_on' | 'always_off'
  /** Environment variables for the process. The runner removes every other `OTEL_*` variable. */
  env?: Record<string, string>
}

export interface ErrorSpec {
  name: string
  message: string
}

export interface TurnRecordSpec {
  query?: Value
  answer?: Value
  messages?: Value[]
  toolCalled?: Value
  model?: Value
  outcome?: Value
  guardrails?: Value[]
  timings?: Value
  usage?: Value
  ms?: Value
}

export type Step =
  | { op: 'init'; options?: { [key: string]: Value } }
  | { op: 'span'; name: string; kind?: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER'; attributes?: { [key: string]: Value }; steps?: Step[] }
  | {
    op: 'turn'
    ref?: string
    options: { agent: string; conversationId?: string; model?: string; maxLength?: number; timeline?: string }
    steps?: Step[]
    record?: TurnRecordSpec
    throw?: ErrorSpec
    return?: Value
  }
  | { op: 'handle'; type: 'tool' | 'model' | 'agent'; name: string; schema?: { [key: string]: Value }; attributes: { [key: string]: Value } }
  | { op: 'set'; attributes: { [key: string]: Value } }
  | { op: 'user'; id: Value }
  | { op: 'session'; id: Value }
  | { op: 'getTraceId' }
  | { op: 'turnRef'; ref?: string }
  | { op: 'feedback'; turn?: string; event: { [key: string]: Value } }
  | { op: 'metadata'; traceId?: string; traceIdOf?: string; eventName: string; attributes: { [key: string]: Value } }
  | { op: 'selfCheck' }
  | { op: 'manifest' }
  | { op: 'registerAttributes'; source: string; attributes: { [key: string]: Value } }
  | { op: 'flush' }
  | { op: 'advanceClock'; ms: number }
  | { op: 'env'; set: { [name: string]: string | null } }
  | { op: 'withTimeline'; timeline: string; request?: boolean; steps?: Step[] }
  | { op: 'endRequest'; timeline: string }
  | { op: 'timed'; name: string; attributes?: { [key: string]: Value }; steps?: Step[]; throw?: ErrorSpec }
  | { op: 'scope'; name: string; steps?: Step[] }
  | { op: 'timelineSpan'; name: string; handle: string; attributes?: { [key: string]: Value } }
  | { op: 'timelineClose'; handle: string; attributes?: { [key: string]: Value } }
  | { op: 'annotate'; attributes: { [key: string]: Value } }
  | { op: 'mark'; name: string }
  | { op: 'markLast'; name: string }
  | { op: 'timelineSet'; name: string; value: Value }
  | { op: 'recordUsage'; timeline: string; usage: { [key: string]: Value } }
  | { op: 'timelineJSON'; timeline: string }
  | { op: 'setTimelineAttributes'; timeline: string }

export interface Scenario {
  name: string
  description: string
  covers: string[]
  notes?: string
  setup: Setup
  steps: Step[]
}

/** Replaces the special encodings with the values they stand for. */
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if ('$repeat' in o) {
      const { text, count } = o.$repeat as { text: string; count: number }
      return text.repeat(count)
    }
    // 'NaN', 'Infinity' or '-Infinity'.
    if ('$number' in o) return Number(o.$number)
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decode(v)]))
  }
  return value
}

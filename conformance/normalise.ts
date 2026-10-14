/**
 * Turns what one scenario exported into its normalised output. The rules
 * are in `AGENTS.md` in this folder, and `output.schema.json` is the shape.
 *
 * - The IDs that feedback derives from a session become
 *   `session-trace:<session>` and `session-span:<session>`.
 * - Other trace IDs become `trace-1`, `trace-2`, and so on, in order of first use.
 * - The span ID of an exported span becomes `span:<path>`. A span ID that is
 *   the first 16 hex digits of a trace ID becomes `prefix:<trace label>`.
 *   Any other span ID becomes `external-1`, `external-2`, and so on.
 * - Times become milliseconds from the start of the scenario clock.
 * - Values that differ between runs or between ports become placeholders.
 */
import { createHash } from 'node:crypto'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { HrTime } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'

export interface RawResult {
  step: string
  op: string
  [key: string]: unknown
}

export interface RawOutput {
  scenario: string
  clockOrigin: number
  spans: ReadableSpan[]
  logRecords: ReadableLogRecord[]
  results: RawResult[]
  /** The session of each feedback event, as the package wrote it. */
  sessions: Set<string>
  /** The session IDs the package chose for feedback with no session. */
  processSessions: Set<string>
}

export const PLACEHOLDERS = {
  version: '<version>',
  packageName: '<package>',
  stacktrace: '<stacktrace>',
  processSession: '<process-session>',
} as const

class Labels {
  private readonly traces = new Map<string, string>()
  private readonly sessionTraces = new Map<string, string>()
  private readonly sessionSpans = new Map<string, string>()
  private readonly external = new Map<string, string>()
  private count = 0

  constructor(private readonly exported: Map<string, string>, sessions: Set<string>, processSessions: Set<string>) {
    // The rule in src/feedback.ts and in Flywheel's src/feedback/emit.ts.
    for (const session of sessions) {
      const hash = createHash('sha256').update(`flywheel-feedback-session:${session}`).digest('hex')
      const name = processSessions.has(session) ? PLACEHOLDERS.processSession : session
      this.sessionTraces.set(hash.slice(0, 32), `session-trace:${name}`)
      this.sessionSpans.set(hash.slice(32, 48), `session-span:${name}`)
    }
  }

  trace(id: string | undefined): string | null {
    if (id === undefined) return null
    const session = this.sessionTraces.get(id)
    if (session !== undefined) return session
    let label = this.traces.get(id)
    if (!label) {
      label = `trace-${++this.count}`
      this.traces.set(id, label)
    }
    return label
  }

  span(id: string | undefined): string | null {
    if (id === undefined) return null
    const path = this.exported.get(id)
    if (path !== undefined) return `span:${path}`
    const session = this.sessionSpans.get(id)
    if (session !== undefined) return session
    for (const [traceId, label] of this.traces) if (traceId.slice(0, 16) === id) return `prefix:${label}`
    let label = this.external.get(id)
    if (!label) {
      label = `external-${this.external.size + 1}`
      this.external.set(id, label)
    }
    return label
  }
}

/**
 * The path of each exported span: the names of its exported ancestors and its
 * own, joined by ' > '. A name gets ' #<n>' when an earlier span in export
 * order has the same exported parent (or none) and the same name.
 */
function spanPaths(spans: ReadableSpan[]): Map<string, string> {
  const byId = new Map(spans.map(s => [s.spanContext().spanId, s]))
  const parentOf = (s: ReadableSpan) => (s.parentSpanContext ? byId.get(s.parentSpanContext.spanId) : undefined)
  const paths = new Map<string, string>()
  const path = (s: ReadableSpan): string => {
    const id = s.spanContext().spanId
    const known = paths.get(id)
    if (known !== undefined) return known
    const parent = parentOf(s)
    const repeat = spans.slice(0, spans.indexOf(s)).filter(o => o.name === s.name && parentOf(o) === parent).length
    const name = repeat === 0 ? s.name : `${s.name} #${repeat + 1}`
    const result = parent ? `${path(parent)} > ${name}` : name
    paths.set(id, result)
    return result
  }
  for (const s of spans) path(s)
  return paths
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000
}

function offset(time: HrTime, origin: number): number {
  return round(time[0] * 1000 - origin + time[1] / 1e6)
}

function attributes(attrs: Record<string, unknown>, sessions: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'flywheel.version') out[key] = PLACEHOLDERS.version
    else if (key === 'exception.stacktrace') out[key] = PLACEHOLDERS.stacktrace
    else if (typeof value === 'string' && sessions.has(value)) out[key] = PLACEHOLDERS.processSession
    else out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

const STATUS: Record<number, string> = {
  [SpanStatusCode.UNSET]: 'UNSET',
  [SpanStatusCode.OK]: 'OK',
  [SpanStatusCode.ERROR]: 'ERROR',
}

interface Ref {
  traceId: string
  spanId: string
}

function result(r: RawResult, labels: Labels): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r }
  const ref = (v: unknown) => {
    const x = v as Ref | undefined
    return x ? { traceId: labels.trace(x.traceId), spanId: labels.span(x.spanId) } : null
  }
  if ('ref' in r) out.ref = ref(r.ref)
  if (r.op === 'getTraceId') out.value = labels.trace(r.value as string | undefined)
  if (r.op === 'selfCheck') {
    const report = { ...(r.value as Record<string, unknown>) }
    const startup = report.startupSpan as { traceId: string; sampled: boolean } | undefined
    report.startupSpan = startup ? { ...startup, traceId: labels.trace(startup.traceId) } : null
    out.value = report
  }
  if (r.op === 'manifest') {
    out.value = { ...(r.value as object), package: { name: PLACEHOLDERS.packageName, version: PLACEHOLDERS.version } }
  }
  return out
}

export function normalise(raw: RawOutput): Record<string, unknown> {
  const paths = spanPaths(raw.spans)
  const labels = new Labels(paths, raw.sessions, raw.processSessions)
  const origin = raw.clockOrigin

  const spans = raw.spans.map(s => ({
    path: paths.get(s.spanContext().spanId),
    name: s.name,
    trace: labels.trace(s.spanContext().traceId),
    parent: labels.span(s.parentSpanContext?.spanId),
    kind: SpanKind[s.kind],
    scope: s.instrumentationScope.name,
    startMs: offset(s.startTime, origin),
    durationMs: round(s.duration[0] * 1000 + s.duration[1] / 1e6),
    status: s.status.code === SpanStatusCode.ERROR
      ? { code: 'ERROR', message: s.status.message ?? '' }
      : { code: STATUS[s.status.code] },
    attributes: attributes(s.attributes, raw.processSessions),
    events: s.events.map(e => ({
      name: e.name,
      timeMs: offset(e.time, origin),
      attributes: attributes(e.attributes ?? {}, raw.processSessions),
    })),
  }))

  const logRecords = raw.logRecords.map(r => ({
    scope: r.instrumentationScope.name,
    severityNumber: r.severityNumber ?? null,
    severityText: r.severityText ?? null,
    body: r.body ?? null,
    trace: labels.trace(r.spanContext?.traceId),
    span: labels.span(r.spanContext?.spanId),
    timeMs: offset(r.hrTime, origin),
    attributes: attributes(r.attributes, raw.processSessions),
  }))

  const results = raw.results.map(r => result(r, labels))
  return { scenario: raw.scenario, results, spans, logRecords }
}

/** Sorts object keys, writes undefined as null, and indents by two spaces. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === undefined) return null
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`
}

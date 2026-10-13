/**
 * One record per turn.
 *
 * `turn(options, fn)` opens the turn's root span and runs `fn` with that span
 * active, so model calls inside `fn` become its children. The caller fills
 * `turn.record` during the turn. When `fn` settles, the record goes on the
 * root span and the span ends.
 *
 * The span name and the `gen_ai.*` keys follow the OpenTelemetry GenAI
 * semantic conventions, as published in @opentelemetry/semantic-conventions
 * 1.43.0 (incubating exports). The package does not import them, because the
 * names are experimental and the core entry has two peer dependencies only.
 */
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import type { AttributeValue, Span } from '@opentelemetry/api'
import { checkValue, reportInvalid, DEFAULT_MAX_LENGTH } from './schema.js'
import type { WriteSettings } from './schema.js'
import { registerAttributes } from './manifest.js'
import type { RequestTimeline } from './timeline.js'
import { TURN_ATTRIBUTES, TURN_OUTCOMES } from './turnAttributes.js'
import type { TurnOutcome } from './turnAttributes.js'
import type { AttributeSpec, TurnRef } from './types.js'

const TRACER_NAME = 'flywheel'

export { TURN_ATTRIBUTES, TURN_OUTCOMES } from './turnAttributes.js'
export type { TurnOutcome } from './turnAttributes.js'

/** A tool call that a message asks for. The names match Flywheel's `TurnOutput`. */
export interface TurnToolCall {
  toolName: string
  input: Record<string, unknown>
  toolCallId?: string
}

/**
 * One message of the turn. A tool result is a message with the role `tool`,
 * the `toolName` it answers and its result in `content`.
 */
export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: TurnToolCall[]
  toolName?: string
  toolCallId?: string
}

export interface TurnGuardrail {
  name: string
  passed: boolean
  reason?: string
}

export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
}

/**
 * The turn record. Fields that Flywheel's `TurnOutput` also has (`query`,
 * `answer`, `messages`, `toolCalled`, `model`, `ms`, `timings`) keep its names.
 */
export interface TurnRecord {
  query?: string
  answer?: string
  messages: TurnMessage[]
  /** The default is true when any message has a tool call. */
  toolCalled?: boolean
  model?: string
  outcome?: TurnOutcome
  guardrails: TurnGuardrail[]
  /** Step durations in milliseconds, keyed by step. The default comes from `options.timeline`. */
  timings?: Record<string, number>
  usage?: TurnUsage
  /** Wall-clock time of the turn in milliseconds. The default is the time `fn` took. */
  ms?: number
}

export interface TurnOptions {
  /** The agent name. The span is named `invoke_agent {agent}`. */
  agent: string
  conversationId?: string
  model?: string
  /** The limit for each string and each message content. The default is 1024. */
  maxLength?: number
  /** The request clock. Its closed spans and token counts fill `timings` and `usage` when the record leaves them out. */
  timeline?: RequestTimeline
}

export interface Turn {
  readonly record: TurnRecord
  /** The root span, for `feedback({ turn })`. Undefined on the noop instance. */
  readonly ref: TurnRef | undefined
}

const OUTCOME_SPEC: AttributeSpec = { type: 'enum', values: TURN_OUTCOMES }
const NUMBER_SPEC: AttributeSpec = { type: 'number' }
const COUNT_SPEC: AttributeSpec = { type: 'count' }

function cut(value: string, limit: number): { value: string; truncated: boolean } {
  return value.length <= limit ? { value, truncated: false } : { value: value.slice(0, limit), truncated: true }
}

function newRecord(options: TurnOptions): TurnRecord {
  return { messages: [], guardrails: [], ...(options.model ? { model: options.model } : {}) }
}

/** Writes one checked value, or names the key in `flywheel.attribute_error`. */
function write(span: Span, settings: WriteSettings, attribute: string, spec: AttributeSpec, raw: unknown, limit: number): void {
  if (raw === undefined) return
  const checked = checkValue(spec, raw, limit)
  if (typeof checked === 'string') {
    reportInvalid(span, settings, attribute, checked)
    return
  }
  span.setAttribute(attribute, checked.value)
  if (checked.truncated) span.setAttribute(`${attribute}.truncated`, true)
}

function timelineDefaults(timeline: RequestTimeline): { timings: Record<string, number>; usage: TurnUsage } {
  const payload = timeline.toJSON()
  const timings: Record<string, number> = {}
  for (const s of payload.spans) timings[s.name] = Math.round((s.endMs - s.startMs) * 10) / 10
  const usage: TurnUsage = {}
  if (payload.usage.inputTokens !== undefined) usage.inputTokens = payload.usage.inputTokens
  if (payload.usage.outputTokens !== undefined) usage.outputTokens = payload.usage.outputTokens
  return { timings, usage }
}

function writeRecord(span: Span, settings: WriteSettings, record: TurnRecord, options: TurnOptions): void {
  const limit = options.maxLength ?? DEFAULT_MAX_LENGTH
  const fromTimeline = options.timeline ? timelineDefaults(options.timeline) : undefined

  write(span, settings, 'app.turn.outcome', OUTCOME_SPEC, record.outcome, limit)
  write(span, settings, 'gen_ai.request.model', { type: 'string' }, record.model, limit)
  write(span, settings, 'app.turn.query', { type: 'string' }, record.query, limit)
  write(span, settings, 'app.turn.answer', { type: 'string' }, record.answer, limit)
  write(span, settings, 'app.turn.ms', NUMBER_SPEC, record.ms, limit)

  // Each content is cut on its own, so the JSON stays valid. The shape is the
  // one FLS writes to app.model.legal-analysis.messages.
  let truncated = false
  const messages = record.messages.map(m => {
    const content = cut(m.content, limit)
    truncated ||= content.truncated
    return { ...m, content: content.value }
  })
  if (messages.length > 0) {
    span.setAttribute('app.turn.messages', JSON.stringify(messages))
    if (truncated) span.setAttribute('app.turn.messages.truncated', true)
  }
  span.setAttribute('app.turn.message_count', messages.length)
  span.setAttribute('app.turn.tool_called', record.toolCalled ?? record.messages.some(m => (m.toolCalls?.length ?? 0) > 0))

  for (const g of record.guardrails) {
    write(span, settings, `app.turn.guardrail.${g.name}.passed`, { type: 'boolean' }, g.passed, limit)
    write(span, settings, `app.turn.guardrail.${g.name}.reason`, { type: 'string' }, g.reason, limit)
  }

  for (const [step, ms] of Object.entries(record.timings ?? fromTimeline?.timings ?? {})) {
    write(span, settings, `app.turn.timing.${step}`, NUMBER_SPEC, ms, limit)
  }

  const usage = record.usage ?? fromTimeline?.usage ?? {}
  write(span, settings, 'gen_ai.usage.input_tokens', COUNT_SPEC, usage.inputTokens, limit)
  write(span, settings, 'gen_ai.usage.output_tokens', COUNT_SPEC, usage.outputTokens, limit)
}

export async function runTurn<T>(
  settings: WriteSettings,
  options: TurnOptions,
  fn: (turn: Turn) => T | Promise<T>,
): Promise<T> {
  // The manifest registers these names when the package loads. This call
  // restores them after a caller replaces the `turn` source.
  registerAttributes('turn', TURN_ATTRIBUTES)
  const attributes: Record<string, AttributeValue> = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': options.agent,
  }
  if (options.conversationId) attributes['gen_ai.conversation.id'] = options.conversationId

  const tracer = trace.getTracer(TRACER_NAME)
  return tracer.startActiveSpan(`invoke_agent ${options.agent}`, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    const { traceId, spanId } = span.spanContext()
    const turn: Turn = { record: newRecord(options), ref: { traceId, spanId } }
    const start = performance.now()
    try {
      const result = await fn(turn)
      turn.record.outcome ??= 'answered'
      return result
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      turn.record.outcome = aborted ? 'aborted' : 'error'
      if (err instanceof Error) span.recordException(err)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      turn.record.ms ??= Math.round(performance.now() - start)
      try {
        writeRecord(span, settings, turn.record, options)
      } finally {
        span.end()
      }
    }
  })
}

/** The noop turn: `fn` runs with a record that nothing writes. */
export async function runNoopTurn<T>(options: TurnOptions, fn: (turn: Turn) => T | Promise<T>): Promise<T> {
  return fn({ record: newRecord(options), ref: undefined })
}

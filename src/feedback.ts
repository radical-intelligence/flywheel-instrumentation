import { createHash, randomUUID } from 'node:crypto'
import { trace, isSpanContextValid, ROOT_CONTEXT, SpanKind, TraceFlags } from '@opentelemetry/api'
import type { AttributeValue, Context } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import type { FeedbackClass, FeedbackEvent, TurnRef } from './types.js'

const SCOPE_NAME = 'flywheel'
const DEFAULT_NAMESPACE = 'feedback'

// The ADR 005 class of each kind. A rating is explicit, so it has a class of its own.
const CLASS_OF: Record<FeedbackEvent['kind'], FeedbackClass> = {
  rating: 'explicit',
  decision: 'decision',
  edit: 'decision',
  dwell: 'ui',
  next_message: 'conversation',
}

// The session that feedback with no turn and no session joins.
const PROCESS_SESSION = `process-${randomUUID().slice(0, 8)}`

/** The trace ID and span ID of the active span, or undefined with no active span. */
export function activeTurnRef(): TurnRef | undefined {
  const ctx = trace.getActiveSpan()?.spanContext()
  if (!ctx || !isSpanContextValid(ctx)) return undefined
  return { traceId: ctx.traceId, spanId: ctx.spanId }
}

/**
 * The context the feedback span starts in.
 *
 * A valid turn ref makes the turn span the parent. Otherwise the parent is
 * derived from the session id, so every process puts one session's events
 * on one trace. That parent span is never written.
 */
function parentContext(event: FeedbackEvent, session: string): Context {
  const turn = event.turn
  if (turn) {
    const ctx = { traceId: turn.traceId, spanId: turn.spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true }
    if (isSpanContextValid(ctx)) return trace.setSpanContext(ROOT_CONTEXT, ctx)
  }
  return trace.setSpanContext(ROOT_CONTEXT, sessionSpanContext(session))
}

function sessionSpanContext(session: string) {
  const hash = createHash('sha256').update(`flywheel-feedback-session:${session}`).digest('hex')
  return { traceId: hash.slice(0, 32), spanId: hash.slice(32, 48), traceFlags: TraceFlags.SAMPLED, isRemote: true }
}

function feedbackAttributes(event: FeedbackEvent, session: string): Record<string, AttributeValue> {
  const ns = event.namespace ?? DEFAULT_NAMESPACE
  const attrs: Record<string, AttributeValue> = {
    [`${ns}.kind`]: event.kind,
    [`${ns}.class`]: CLASS_OF[event.kind],
    [`${ns}.session`]: session,
  }
  const put = (key: string, value: AttributeValue | undefined) => {
    if (value !== undefined) attrs[`${ns}.${key}`] = value
  }

  switch (event.kind) {
    case 'rating':
      put('rating', event.rating)
      for (const [criterion, value] of Object.entries(event.ratings ?? {})) put(`rating.${criterion}`, value)
      put('reason', event.reason)
      // Joined with commas, as FLS's saved queries read it.
      if (event.reasons?.length) put('reasons', event.reasons.join(','))
      put('comment', event.comment)
      break
    case 'decision':
      put('decision', event.decision)
      put('reason', event.reason)
      break
    case 'edit':
      put('edit.draft', event.draft)
      put('edit.text', event.text)
      break
    case 'dwell':
      put('element', event.element)
      put('dwell_ms', event.dwellMs)
      break
    case 'next_message':
      put('next_message', event.text)
      break
  }

  put('subject.kind', event.subject?.kind)
  put('subject.id', event.subject?.id)
  put('subject.url', event.subject?.url)
  put('actor.id', event.actor?.id)
  put('actor.kind', event.actor?.kind)
  return { ...attrs, ...event.attributes }
}

function startTime(at: FeedbackEvent['at']): Date {
  const date = at === undefined ? new Date() : new Date(at)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

/**
 * Write one feedback event as a span in the trace of the turn it rates.
 *
 * With `customEvents`, also emit a log record named by
 * `microsoft.custom_event.name` in the feedback span's context. The Azure
 * Monitor exporter writes that record to `customEvents`.
 */
export function emitFeedback(event: FeedbackEvent, customEvents: boolean): void {
  const name = event.name ?? `feedback.${event.kind}`
  const session = event.session ?? PROCESS_SESSION
  const time = startTime(event.at)
  const attributes = { ...feedbackAttributes(event, session), 'event.name': name }

  const span = trace.getTracer(SCOPE_NAME).startSpan(
    name,
    { kind: SpanKind.INTERNAL, startTime: time, attributes },
    parentContext(event, session),
  )
  span.end(time)

  if (!customEvents) return
  logs.getLogger(SCOPE_NAME).emit({
    context: trace.setSpan(ROOT_CONTEXT, span),
    timestamp: time,
    severityNumber: SeverityNumber.INFO,
    attributes: { ...attributes, 'microsoft.custom_event.name': name },
  })
}

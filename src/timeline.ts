/**
 * Request timeline: every delay in one request, on one clock.
 *
 * The product starts a monotonic clock (`performance.now()`) when the request
 * arrives, and keeps the timeline in AsyncLocalStorage. Code deep in the call
 * stack then records spans with no extra parameters. Each offset is
 * milliseconds since the request arrived, so the spans of sequential work add
 * up to the request's wall-clock time.
 *
 * Outside a request, `timeline()` returns a handle that records nothing.
 *
 * Span names are dotted. `timed(name, fn)` records a span and runs `fn` in a
 * scope, and every span inside that scope takes the name as a prefix.
 *
 * The Express middleware is in `express.ts`, and the AI SDK stream recorder
 * is in `ai-sdk.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type SpanAttrs = Record<string, string | number | boolean>

export interface TimelineSpan {
  name: string
  startMs: number
  endMs: number
  attrs?: SpanAttrs
}

export interface TimelinePayload {
  spans: TimelineSpan[]
  marks: Record<string, number>
  usage: Record<string, number>
}

export interface OpenSpan {
  name: string
  startMs: number
  endMs?: number
  attrs?: SpanAttrs
}

/** Offsets keep one decimal place: enough for sub-millisecond steps. */
function round(ms: number): number {
  return Math.round(ms * 10) / 10
}

export class RequestTimeline {
  private readonly origin: number
  private readonly spans: OpenSpan[] = []
  private readonly names = new Map<string, number>()
  private readonly marks: Record<string, number> = {}
  private readonly usage: Record<string, number> = {}
  private request?: OpenSpan

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.origin = clock()
  }

  /** Milliseconds since the request arrived. */
  now(): number {
    return round(this.clock() - this.origin)
  }

  /**
   * Open a span. A repeated name gets a `#2`, `#3` suffix, so two calls in
   * one scope (for example two model steps) do not overwrite each other.
   */
  open(name: string, attrs?: SpanAttrs): OpenSpan {
    const seen = (this.names.get(name) ?? 0) + 1
    this.names.set(name, seen)
    const span: OpenSpan = { name: seen > 1 ? `${name}#${seen}` : name, startMs: this.now() }
    if (attrs) span.attrs = { ...attrs }
    this.spans.push(span)
    return span
  }

  close(span: OpenSpan, attrs?: SpanAttrs): void {
    if (span.endMs === undefined) span.endMs = this.now()
    if (attrs) span.attrs = { ...span.attrs, ...attrs }
  }

  /** Open the `request` span, for the whole request. The first middleware calls it. */
  startRequest(): void {
    this.request ??= this.open('request')
  }

  /** Close the `request` span. Call it after the last write of the response. */
  endRequest(): void {
    if (this.request) this.close(this.request)
  }

  /** Record the first time only. */
  mark(name: string): void {
    if (!(name in this.marks)) this.marks[name] = this.now()
  }

  /** Record every time, so the last call wins. */
  markLast(name: string): void {
    this.marks[name] = this.now()
  }

  set(name: string, value: number): void {
    if (Number.isFinite(value)) this.usage[name] = value
  }

  /** Closed spans in start order. A span still open is left out. */
  toJSON(): TimelinePayload {
    const spans = this.spans
      .filter((s): s is OpenSpan & { endMs: number } => s.endMs !== undefined)
      .map(s => ({ name: s.name, startMs: s.startMs, endMs: s.endMs, ...(s.attrs ? { attrs: s.attrs } : {}) }))
      .sort((a, b) => a.startMs - b.startMs)
    return { spans, marks: { ...this.marks }, usage: { ...this.usage } }
  }
}

interface Scope {
  timeline: RequestTimeline
  prefix: string
  span?: OpenSpan
}

const store = new AsyncLocalStorage<Scope>()

export interface Timeline {
  /** Open a span now. Call the returned function to close it. */
  span(name: string, attrs?: SpanAttrs): (attrs?: SpanAttrs) => void
  /** Record `fn` as a span, and name every span inside it under `name`. */
  timed<T>(name: string, fn: (tl: Timeline) => Promise<T> | T, attrs?: SpanAttrs): Promise<T>
  /** Run `fn` with `name` as the prefix for its spans, with no span of its own. */
  scope<T>(name: string, fn: (tl: Timeline) => T): T
  /** Add attributes to the span that `timed` opened for this scope. */
  annotate(attrs: SpanAttrs): void
  mark(name: string): void
  markLast(name: string): void
  set(name: string, value: number): void
}

const NOOP: Timeline = {
  span: () => () => {},
  timed: async (_name, fn) => fn(NOOP),
  scope: (_name, fn) => fn(NOOP),
  annotate: () => {},
  mark: () => {},
  markLast: () => {},
  set: () => {},
}

function handle(scope: Scope): Timeline {
  const { timeline: tl, prefix } = scope
  const qualify = (name: string) => (prefix ? `${prefix}.${name}` : name)
  const self: Timeline = {
    span(name, attrs) {
      const span = tl.open(qualify(name), attrs)
      return (endAttrs) => tl.close(span, endAttrs)
    },
    async timed(name, fn, attrs) {
      const span = tl.open(qualify(name), attrs)
      const child: Scope = { timeline: tl, prefix: span.name, span }
      try {
        return await store.run(child, () => fn(handle(child)))
      } finally {
        tl.close(span)
      }
    },
    scope(name, fn) {
      const child: Scope = { timeline: tl, prefix: qualify(name) }
      return store.run(child, () => fn(handle(child)))
    },
    annotate(attrs) {
      if (scope.span) scope.span.attrs = { ...scope.span.attrs, ...attrs }
    },
    mark: (name) => tl.mark(name),
    markLast: (name) => tl.markLast(name),
    set: (name, value) => tl.set(name, value),
  }
  return self
}

/** The current request's timeline, or a handle that records nothing. */
export function timeline(): Timeline {
  const scope = store.getStore()
  return scope ? handle(scope) : NOOP
}

/** Run `fn` with `tl` as the current timeline, at the root scope. */
export function runWithTimeline<T>(tl: RequestTimeline, fn: () => T): T {
  return store.run({ timeline: tl, prefix: '' }, fn)
}

/** Record `fn` as a span on the current timeline. */
export function timed<T>(name: string, fn: (tl: Timeline) => Promise<T> | T, attrs?: SpanAttrs): Promise<T> {
  return timeline().timed(name, fn, attrs)
}

/** The token usage fields that `recordUsage` reads, from AI SDK 4 or 5. */
export interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
  reasoningTokens?: number
  cachedInputTokens?: number
}

/**
 * Token usage, plus output tokens per second over the visible output stream.
 * The rate counts output tokens less reasoning tokens (the answer text and
 * the tool arguments), over the time from the first of those tokens to the
 * last token.
 */
export function recordUsage(tl: Timeline, usage: UsageLike, marks: Record<string, number>): void {
  const reasoning = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens
  if (usage.inputTokens !== undefined) tl.set('inputTokens', usage.inputTokens)
  if (usage.outputTokens !== undefined) tl.set('outputTokens', usage.outputTokens)
  if (reasoning !== undefined) tl.set('reasoningTokens', reasoning)
  if (cached !== undefined) tl.set('cachedInputTokens', cached)

  const starts = Object.entries(marks)
    .filter(([name]) => name === 'chat.firstText' || /^chat\.tool\..+\.inputStart$/.test(name))
    .map(([, ms]) => ms)
  const first = starts.length ? Math.min(...starts) : undefined
  const last = marks['chat.lastToken']
  const visible = (usage.outputTokens ?? 0) - (reasoning ?? 0)
  if (first !== undefined && last !== undefined && last > first && visible > 0) {
    tl.set('outputTokensPerSecond', Math.round((visible / ((last - first) / 1000)) * 10) / 10)
  }
}

/**
 * The timeline as flat OpenTelemetry attributes on the request span:
 * `app.timeline.<span>.start_ms`, `app.timeline.<span>.ms`,
 * `app.timeline.<span>.attr.<key>`, `app.timeline.mark.<name>` and
 * `app.timeline.usage.<name>`.
 */
export function timelineAttributes(payload: TimelinePayload): SpanAttrs {
  const out: SpanAttrs = {}
  for (const s of payload.spans) {
    out[`app.timeline.${s.name}.start_ms`] = s.startMs
    out[`app.timeline.${s.name}.ms`] = round(s.endMs - s.startMs)
    for (const [key, value] of Object.entries(s.attrs ?? {})) out[`app.timeline.${s.name}.attr.${key}`] = value
  }
  for (const [name, ms] of Object.entries(payload.marks)) out[`app.timeline.mark.${name}`] = ms
  for (const [name, value] of Object.entries(payload.usage)) out[`app.timeline.usage.${name}`] = value
  return out
}

/** The clock methods, the same on the live and the noop instance. */
export const clockMethods = {
  createTimeline: (clock?: () => number) => new RequestTimeline(clock),
  timeline,
  runWithTimeline,
  timed,
  recordUsage,
  timelineAttributes,
}

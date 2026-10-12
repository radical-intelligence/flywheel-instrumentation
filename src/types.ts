import type { AttributeValue } from '@opentelemetry/api'
import type { RequestTimeline, SpanAttrs, Timeline, TimelinePayload, UsageLike } from './timeline.js'
import type { Turn, TurnOptions } from './turn.js'

export type NodeType = 'tool' | 'model' | 'agent'

/** A rename: the key was called `from`, and keeps that name too until 00:00 UTC on `until` (YYYY-MM-DD). */
export interface Rename {
  from: string
  until: string
}

interface SpecBase {
  renamedFrom?: Rename
}

/**
 * The type of one declared key. `count` is a non-negative integer, for a
 * count of items in place of the items. A string is cut at `maxLength`.
 */
export type AttributeSpec =
  | (SpecBase & { type: 'string'; maxLength?: number })
  | (SpecBase & { type: 'string[]'; maxLength?: number })
  | (SpecBase & { type: 'enum'; values: readonly string[] })
  | (SpecBase & { type: 'count' })
  | (SpecBase & { type: 'number' })
  | (SpecBase & { type: 'boolean' })

export interface NodeSchema {
  attributes: Record<string, AttributeSpec>
  /** The string length limit for keys that set none. The default is 1024. */
  maxLength?: number
}

/** The value type that a spec accepts. */
export type SpecValue<S extends AttributeSpec> =
  S extends { type: 'string' } ? string
  : S extends { type: 'string[]' } ? string[]
  : S extends { type: 'enum'; values: readonly (infer V)[] } ? V
  : S extends { type: 'count' | 'number' } ? number
  : S extends { type: 'boolean' } ? boolean
  : never

/** The attributes that `set()` accepts for a schema: declared keys only, each optional. */
export type SchemaAttributes<S extends NodeSchema> = {
  [K in keyof S['attributes']]?: SpecValue<S['attributes'][K]>
}

export interface NodeHandle<A = Record<string, AttributeValue>> {
  set(attrs: A): void
}

/** The node schemas a product declares, by node type and node name. */
export type NodeSchemas = { [T in NodeType]?: Record<string, NodeSchema> }

export interface InitOptions {
  /**
   * Throw on an invalid write, in place of dropping it. `init()` also throws
   * when the self-check fails. For tests only.
   */
  strict?: boolean
  /** The clock for renames, in milliseconds since the epoch. The default is `Date.now`. */
  now?: () => number
  /**
   * Also emit each feedback event as a log record named by
   * `microsoft.custom_event.name`, which the Azure Monitor exporter writes
   * to `customEvents`. Default false.
   */
  azureCustomEvents?: boolean
  /** The node schemas the product uses. `manifest()` and `selfCheck()` read them. */
  schemas?: NodeSchemas
  /**
   * The product calls `metadata()`, so the self-check fails when no logger
   * provider is registered. The default is the value of `azureCustomEvents`.
   */
  requireLoggerProvider?: boolean
  /** The largest attribute value, in bytes, that the exporter keeps. The default is 8192. */
  valueSizeLimit?: number
}

/** One attribute name that the product can write on a turn span. */
export interface ManifestAttribute {
  name: string
  type: AttributeSpec['type']
  /** `core`, `<type>.<name>` for a node, or the source a module registered. */
  source: string
  /** The allowed values of an enum. */
  values?: string[]
  /** The length limit of a string, or of each item of a string array. */
  maxLength?: number
  /** Set on a renamed name: the attribute that this name repeats. */
  aliasOf?: string
  /** Set on a renamed name: the date (YYYY-MM-DD) its writes stop. */
  until?: string
}

/** Every attribute name the product can write, for tools that do not run JavaScript. */
export interface InstrumentationManifest {
  manifestVersion: 1
  package: { name: string; version: string }
  attributes: ManifestAttribute[]
}

export type SelfCheckIssueCode =
  | 'not_initialised'
  | 'no_tracer_provider'
  | 'no_logger_provider'
  | 'logger_provider_unknown'
  | 'startup_span_not_sampled'
  | 'attribute_count_limit'
  | 'value_size_limit'

export interface SelfCheckIssue {
  /** An error sets `ok` to false. A warning does not. */
  level: 'error' | 'warning'
  code: SelfCheckIssueCode
  message: string
}

export interface SelfCheckReport {
  /** False when any issue is an error. */
  ok: boolean
  /** A tracer provider is registered as the global provider. */
  tracerProvider: boolean
  /** The flywheel logger is enabled. Undefined when the logs API cannot tell. */
  loggerProvider: boolean | undefined
  /** The `flywheel.startup` span this check emitted, or undefined when it emitted none. */
  startupSpan: { traceId: string; sampled: boolean } | undefined
  /** The span attribute count limit, and where the check read it. */
  attributeCountLimit: { value: number; source: 'sdk' | 'env' | 'default' }
  valueSizeLimit: number
  /** The number of attribute names each node can write, and the total for one turn. */
  attributeCounts: { turn: number; nodes: Record<string, number> }
  issues: SelfCheckIssue[]
}

export interface FlywheelInstance {
  tool(name: string): NodeHandle
  tool<const S extends NodeSchema>(name: string, schema: S): NodeHandle<SchemaAttributes<S>>
  model(name: string): NodeHandle
  model<const S extends NodeSchema>(name: string, schema: S): NodeHandle<SchemaAttributes<S>>
  agent(name: string): NodeHandle
  agent<const S extends NodeSchema>(name: string, schema: S): NodeHandle<SchemaAttributes<S>>
  set(attrs: Record<string, AttributeValue>): void
  /** Sets `enduser.id` on the active span. The id must be opaque, not personal data. */
  user(id: string): void
  /** Sets `session.id` on the active span. The id must be opaque, not personal data. */
  session(id: string): void
  /** @deprecated Use `feedback()`. It writes a span on the turn's trace, which Langfuse also ingests. */
  metadata(traceId: string, eventName: string, attrs: Record<string, AttributeValue>): void
  getTraceId(): string | undefined
  /** The trace ID and span ID of the active span. Store it with the response, so later feedback can name the turn. */
  turnRef(): TurnRef | undefined
  /** Write one feedback event as a span, parented to the turn span that `event.turn` names. */
  feedback(event: FeedbackEvent): void
  aiSdkTelemetry(options?: AiSdkTelemetryOptions): AiSdkTelemetryConfig
  flush(): Promise<void>
  /** A new request clock. It starts now, or at `clock()` when given. */
  createTimeline(clock?: () => number): RequestTimeline
  /** The current request's timeline, or a handle that records nothing. */
  timeline(): Timeline
  /** Run `fn` with `tl` as the current timeline, at the root scope. */
  runWithTimeline<T>(tl: RequestTimeline, fn: () => T): T
  /** Record `fn` as a span on the current timeline. */
  timed<T>(name: string, fn: (tl: Timeline) => Promise<T> | T, attrs?: SpanAttrs): Promise<T>
  /** Record token usage and the visible output rate on `tl`. */
  recordUsage(tl: Timeline, usage: UsageLike, marks: Record<string, number>): void
  /** The timeline as flat `app.timeline.*` span attributes. */
  timelineAttributes(payload: TimelinePayload): SpanAttrs
  /**
   * Checks the telemetry setup and emits one `flywheel.startup` span. `init()`
   * runs the same check, and emits the span on the first `init()` only.
   */
  selfCheck(): SelfCheckReport
  /** Every attribute name that the declared schemas and the registered modules can write. */
  manifest(): InstrumentationManifest
  /**
   * Run `fn` as one turn, under a root span named `invoke_agent {agent}`.
   * `fn` fills `turn.record`, which goes on the span when `fn` settles. An
   * error from `fn` sets the outcome and the span status, and is rethrown.
   */
  turn<T>(options: TurnOptions, fn: (turn: Turn) => T | Promise<T>): Promise<T>
}

export interface AiSdkTelemetryOptions {
  functionId?: string
  metadata?: Record<string, string>
}

export interface AiSdkTelemetryConfig {
  isEnabled: boolean
  functionId: string
  recordInputs: boolean
  recordOutputs: boolean
  metadata: Record<string, string>
}

/** The turn a piece of feedback rates: the trace ID and span ID of the turn span. */
export interface TurnRef {
  traceId: string
  spanId: string
}

/** The ADR 005 class of an event. `explicit` is a rating the person gave. */
export type FeedbackClass = 'explicit' | 'decision' | 'ui' | 'conversation'

export interface FeedbackBase {
  /** The span name and `event.name`. Default `feedback.<kind>`. */
  name?: string
  /** The turn the event rates. With no valid ref, the event joins the session's trace. */
  turn?: TurnRef
  /** The session the event happened in. Default: one session per process. */
  session?: string
  /** When the event happened. Default: now. */
  at?: Date | string
  /** What the event is about, in the product's own words. */
  subject?: { kind: string, id?: string, url?: string }
  /** Who acted. */
  actor?: { id: string, kind: 'person' | 'agent' | 'bot' }
  /** The prefix of every typed attribute. Default `feedback`. */
  namespace?: string
  /** Written as given, after the typed attributes. */
  attributes?: Record<string, AttributeValue>
}

export interface RatingFeedback extends FeedbackBase {
  kind: 'rating'
  rating?: string | number
  /** One score per criterion, written as `<namespace>.rating.<criterion>`. */
  ratings?: Record<string, number>
  reason?: string
  reasons?: string[]
  comment?: string
}

export interface DecisionFeedback extends FeedbackBase {
  kind: 'decision'
  /** For example approve, reject, archive or pin. */
  decision: string
  reason?: string
}

export interface EditFeedback extends FeedbackBase {
  kind: 'edit'
  /** The product's draft, kept beside the edit. */
  draft?: string
  /** The text after the person's edit. */
  text: string
}

export interface DwellFeedback extends FeedbackBase {
  kind: 'dwell'
  /** The stable id of the element. */
  element: string
  dwellMs: number
}

export interface NextMessageFeedback extends FeedbackBase {
  kind: 'next_message'
  /** The person's next message after the turn. */
  text: string
}

export type FeedbackEvent = RatingFeedback | DecisionFeedback | EditFeedback | DwellFeedback | NextMessageFeedback

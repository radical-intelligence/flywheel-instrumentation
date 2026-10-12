import type { AttributeValue } from '@opentelemetry/api'
import type { RequestTimeline, SpanAttrs, Timeline, TimelinePayload, UsageLike } from './timeline.js'

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

export interface InitOptions {
  /** Throw on an invalid write, in place of dropping it. For tests only. */
  strict?: boolean
  /** The clock for renames, in milliseconds since the epoch. The default is `Date.now`. */
  now?: () => number
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
  metadata(traceId: string, eventName: string, attrs: Record<string, AttributeValue>): void
  getTraceId(): string | undefined
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

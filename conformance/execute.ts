/**
 * Runs one scenario in this process, and writes its normalised output to
 * stdout as canonical JSON.
 *
 *   node --import tsx conformance/execute.ts <scenario.json>
 *
 * `runner.ts` starts one process for each scenario, because `init()`, the
 * start-up span and the process session are state of the process.
 *
 * The scenario clock drives the wall clock (`Date`) and the monotonic clock
 * (`performance`). The package and the SDK read only these two, so every
 * timestamp, duration and timeline offset is exact.
 */
import { readFileSync } from 'node:fs'
import { context, trace, SpanKind } from '@opentelemetry/api'
import type { AttributeValue } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { AlwaysOffSampler, AlwaysOnSampler, BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { flywheel, init } from '../src/index.js'
import type { AttributeSpec, FeedbackEvent, InitOptions, NodeSchema, RequestTimeline, TurnRecord, TurnRef } from '../src/index.js'
import { registerAttributes } from '../src/manifest.js'
import type { SpanAttrs } from '../src/timeline.js'
import { decode } from './scenario.js'
import type { ErrorSpec, Scenario, Setup, Step, TurnRecordSpec } from './scenario.js'
import { canonicalJson, normalise } from './normalise.js'
import type { RawResult } from './normalise.js'

interface Clock {
  origin: number
  advance(ms: number): void
}

/** Make `Date` and `performance` read the scenario clock. */
function installClock(start: string): Clock {
  const origin = Date.parse(start)
  let elapsed = 0
  const RealDate = Date
  class ScenarioDate extends RealDate {
    constructor(value?: number | string | Date) {
      if (value === undefined) super(origin + elapsed)
      else super(value)
    }

    static now(): number {
      return origin + elapsed
    }
  }
  globalThis.Date = ScenarioDate as unknown as DateConstructor
  Object.defineProperty(performance, 'now', { value: () => elapsed, configurable: true, writable: true })
  Object.defineProperty(performance, 'timeOrigin', { value: origin, configurable: true })
  return { origin, advance: (ms) => { elapsed += ms } }
}

function applyEnv(setup: Setup): void {
  for (const name of Object.keys(process.env)) if (name.startsWith('OTEL_')) delete process.env[name]
  for (const [name, value] of Object.entries(setup.env ?? {})) process.env[name] = value
}

interface Context {
  clock: Clock
  spans: InMemorySpanExporter
  refs: Map<string, TurnRef>
  timelines: Map<string, RequestTimeline>
  closers: Map<string, (attrs?: SpanAttrs) => void>
  results: RawResult[]
  sessions: Set<string>
  processSessions: Set<string>
}

const KINDS: Record<string, SpanKind> = {
  INTERNAL: SpanKind.INTERNAL,
  SERVER: SpanKind.SERVER,
  CLIENT: SpanKind.CLIENT,
  PRODUCER: SpanKind.PRODUCER,
  CONSUMER: SpanKind.CONSUMER,
}

function makeError(spec: ErrorSpec): Error {
  return Object.assign(new Error(spec.message), { name: spec.name })
}

function timelineOf(ctx: Context, id: string): RequestTimeline {
  const tl = ctx.timelines.get(id)
  if (!tl) throw new Error(`scenario: no timeline ${id}`)
  return tl
}

function applyRecord(record: TurnRecord, spec: TurnRecordSpec | undefined): void {
  if (!spec) return
  const target = record as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'messages' || key === 'guardrails') (target[key] as unknown[]).push(...(value as unknown[]))
    else target[key] = value
  }
}

async function runSteps(steps: Step[] | undefined, path: string, ctx: Context): Promise<void> {
  for (const [i, step] of (steps ?? []).entries()) await runStep(step, path === '' ? `${i}` : `${path}.${i}`, ctx)
}

async function runStep(raw: Step, path: string, ctx: Context): Promise<void> {
  // Nested steps decode their own values when they run.
  const step = { ...(decode({ ...raw, steps: undefined }) as Step), ...('steps' in raw ? { steps: raw.steps } : {}) } as Step
  const result: RawResult = { step: path, op: step.op }
  const fw = flywheel()
  try {
    switch (step.op) {
      case 'init': {
        const console = captureConsole()
        try {
          init({ ...(step.options as InitOptions | undefined), now: () => Date.now() })
        } finally {
          result.console = console.stop()
        }
        break
      }
      case 'span': {
        const attributes = step.attributes as Record<string, AttributeValue> | undefined
        await trace.getTracer('conformance').startActiveSpan(step.name, { kind: KINDS[step.kind ?? 'INTERNAL'], attributes }, async (span) => {
          try {
            await runSteps(step.steps, path, ctx)
          } finally {
            span.end()
          }
        })
        break
      }
      case 'turn': {
        const { timeline, ...options } = step.options
        let ref: TurnRef | undefined
        const value = await fw.turn({ ...options, timeline: timeline === undefined ? undefined : timelineOf(ctx, timeline) }, async (turn) => {
          ref = turn.ref
          if (step.ref && turn.ref) ctx.refs.set(step.ref, turn.ref)
          await runSteps(step.steps, path, ctx)
          applyRecord(turn.record, step.record)
          if (step.throw) throw makeError(step.throw)
          return step.return
        }).finally(() => { result.ref = ref })
        result.returned = value
        break
      }
      case 'handle': {
        const handle = step.schema ? fw[step.type](step.name, step.schema as unknown as NodeSchema) : fw[step.type](step.name)
        ;(handle.set as (attrs: Record<string, unknown>) => void)(step.attributes)
        break
      }
      case 'set':
        fw.set(step.attributes as Record<string, AttributeValue>)
        break
      case 'user':
        fw.user(step.id as string)
        break
      case 'session':
        fw.session(step.id as string)
        break
      case 'getTraceId':
        result.value = fw.getTraceId()
        break
      case 'turnRef': {
        const ref = fw.turnRef()
        if (step.ref && ref) ctx.refs.set(step.ref, ref)
        result.ref = ref
        break
      }
      case 'feedback': {
        const event = { ...step.event } as unknown as FeedbackEvent
        if (step.turn !== undefined) event.turn = ctx.refs.get(step.turn)
        const before = ctx.spans.getFinishedSpans().length
        fw.feedback(event)
        if (event.session !== undefined) ctx.sessions.add(event.session)
        // The session that the package chose for the process is not a fixed value.
        else {
          const key = `${event.namespace ?? 'feedback'}.session`
          for (const s of ctx.spans.getFinishedSpans().slice(before)) {
            const session = s.attributes[key]
            if (typeof session === 'string') {
              ctx.sessions.add(session)
              ctx.processSessions.add(session)
            }
          }
        }
        break
      }
      case 'metadata': {
        const traceId = step.traceIdOf !== undefined ? ctx.refs.get(step.traceIdOf)?.traceId : step.traceId
        fw.metadata(traceId ?? '', step.eventName, step.attributes as Record<string, AttributeValue>)
        break
      }
      case 'selfCheck':
        result.value = fw.selfCheck()
        break
      case 'manifest':
        result.value = fw.manifest()
        break
      case 'registerAttributes':
        registerAttributes(step.source, step.attributes as unknown as Record<string, AttributeSpec>)
        break
      case 'flush':
        result.value = await fw.flush()
        break
      case 'advanceClock':
        ctx.clock.advance(step.ms)
        break
      case 'env':
        for (const [name, value] of Object.entries(step.set)) {
          if (value === null) delete process.env[name]
          else process.env[name] = value
        }
        break
      case 'withTimeline': {
        const tl = fw.createTimeline()
        if (step.request) tl.startRequest()
        ctx.timelines.set(step.timeline, tl)
        await fw.runWithTimeline(tl, () => runSteps(step.steps, path, ctx))
        break
      }
      case 'endRequest':
        timelineOf(ctx, step.timeline).endRequest()
        break
      case 'timed':
        await fw.timed(step.name, async () => {
          await runSteps(step.steps, path, ctx)
          if (step.throw) throw makeError(step.throw)
        }, step.attributes as SpanAttrs | undefined)
        break
      case 'scope':
        await fw.timeline().scope(step.name, () => runSteps(step.steps, path, ctx))
        break
      case 'timelineSpan':
        ctx.closers.set(step.handle, fw.timeline().span(step.name, step.attributes as SpanAttrs | undefined))
        break
      case 'timelineClose': {
        const close = ctx.closers.get(step.handle)
        if (!close) throw new Error(`scenario: no timeline span ${step.handle}`)
        close(step.attributes as SpanAttrs | undefined)
        break
      }
      case 'annotate':
        fw.timeline().annotate(step.attributes as SpanAttrs)
        break
      case 'mark':
        fw.timeline().mark(step.name)
        break
      case 'markLast':
        fw.timeline().markLast(step.name)
        break
      case 'timelineSet':
        fw.timeline().set(step.name, step.value as number)
        break
      case 'recordUsage':
        fw.recordUsage(fw.timeline(), step.usage, timelineOf(ctx, step.timeline).toJSON().marks)
        break
      case 'timelineJSON':
        result.value = timelineOf(ctx, step.timeline).toJSON()
        break
      case 'setTimelineAttributes': {
        const attrs = fw.timelineAttributes(timelineOf(ctx, step.timeline).toJSON())
        fw.set(attrs)
        result.value = attrs
        break
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? { name: err.name, message: err.message } : { name: 'Error', message: String(err) }
  }
  ctx.results.push(result)
}

/** Collect what console.error and console.warn write, until `stop()`. */
function captureConsole(): { stop(): { level: 'error' | 'warn'; text: string }[] } {
  const lines: { level: 'error' | 'warn'; text: string }[] = []
  const { error, warn } = console
  console.error = (...args: unknown[]) => { lines.push({ level: 'error', text: args.join(' ') }) }
  console.warn = (...args: unknown[]) => { lines.push({ level: 'warn', text: args.join(' ') }) }
  return {
    stop() {
      console.error = error
      console.warn = warn
      return lines
    },
  }
}

async function main(file: string): Promise<void> {
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario
  const { setup } = scenario
  applyEnv(setup)
  const clock = installClock(setup.clock)

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  const spans = new InMemorySpanExporter()
  const logRecords = new InMemoryLogRecordExporter()
  const tracerProvider = setup.tracerProvider
    ? new BasicTracerProvider({
      sampler: setup.sampler === 'always_off' ? new AlwaysOffSampler() : new AlwaysOnSampler(),
      spanProcessors: [new SimpleSpanProcessor(spans)],
      spanLimits: { attributeCountLimit: setup.attributeCountLimit },
    })
    : undefined
  const loggerProvider = setup.loggerProvider
    ? new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logRecords })] })
    : undefined
  if (tracerProvider) trace.setGlobalTracerProvider(tracerProvider)
  if (loggerProvider) logs.setGlobalLoggerProvider(loggerProvider)

  const ctx: Context = {
    clock,
    spans,
    refs: new Map(),
    timelines: new Map(),
    closers: new Map(),
    results: [],
    sessions: new Set(),
    processSessions: new Set(),
  }
  await runSteps(scenario.steps, '', ctx)
  await tracerProvider?.forceFlush()
  await loggerProvider?.forceFlush()

  const output = normalise({
    scenario: scenario.name,
    clockOrigin: clock.origin,
    spans: spans.getFinishedSpans(),
    logRecords: logRecords.getFinishedLogRecords(),
    results: ctx.results,
    sessions: ctx.sessions,
    processSessions: ctx.processSessions,
  })
  process.stdout.write(canonicalJson(output))
}

const file = process.argv[2]
if (!file) {
  console.error('usage: node --import tsx conformance/execute.ts <scenario.json>')
  process.exit(2)
}
await main(file)

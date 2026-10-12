/**
 * The behaviour contract of the instrumentation package, as it stands.
 *
 * Each case runs against a real OpenTelemetry SDK (see sdk.ts) and asserts
 * with node:assert, with no test framework globals. A runner only has to call
 * `run` for each case, in order:
 *
 *   for (const c of contractCases) test(c.name, c.run)
 *
 * The order matters for the first case. `init()` replaces a module-level
 * instance that nothing resets, so the case that reads `flywheel()` before
 * any `init()` must run first, in a fresh module instance.
 */
import assert from 'node:assert/strict'
import { trace, SpanKind, TraceFlags } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import * as pkg from '../src/index.js'
import { init, flywheel, noopInstance } from '../src/index.js'
import type { NodeSchema, TurnRef } from '../src/index.js'
import { recordStreamPart } from '../src/ai-sdk.js'
import { requestTimeline, startTimeline, timedMiddleware } from '../src/express.js'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { withSdk } from './sdk.js'
import type { Sdk } from './sdk.js'

export interface ContractCase {
  name: string
  run: () => Promise<void>
}

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'

const TURN: TurnRef = { traceId: TRACE_ID, spanId: 'b7ad6b7169203331' }

/** Run a turn span, and return its ref as the turn saw it. */
async function turn(sdk: Sdk, fw: ReturnType<typeof init>): Promise<TurnRef> {
  const ref = await sdk.inSpan('turn', () => fw.turnRef())
  assert.ok(ref)
  return ref
}

const sync = (name: string, fn: () => void): ContractCase => ({ name, run: async () => fn() })

const SEARCH_SCHEMA = {
  attributes: {
    status: { type: 'enum', values: ['ok', 'empty', 'error'] },
    result_count: { type: 'count' },
    latency_ms: { type: 'number' },
    cached: { type: 'boolean' },
    query: { type: 'string' },
    note: { type: 'string', maxLength: 4 },
    chapters: { type: 'string[]' },
  },
} as const satisfies NodeSchema

const at = (iso: string) => () => Date.parse(iso)

/** A clock the case moves by hand, so every offset is exact. */
function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The part of an Express response that the middleware reads. */
const fakeResponse = () => ({ locals: {} }) as unknown as Response
const fakeRequest = {} as Request

export const contractCases: ContractCase[] = [
  // Must stay first. See the header.
  sync('flywheel() returns the noop instance before init()', () => {
    assert.equal(flywheel(), noopInstance)
  }),

  sync('the package exports init, flywheel and noopInstance', () => {
    assert.deepEqual(Object.keys(pkg).sort(), ['flywheel', 'init', 'noopInstance'])
  }),

  sync('init() returns a live instance, and flywheel() returns it after', () => {
    const fw = init()
    assert.notEqual(fw, noopInstance)
    assert.equal(flywheel(), fw)
  }),

  sync('each init() replaces the instance flywheel() returns', () => {
    const first = init()
    const second = init()
    assert.notEqual(first, second)
    assert.equal(flywheel(), second)
  }),

  {
    name: 'tool(name).set writes app.tool.<name>.<key> only, with no app.<name>.<key>',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.tool('search').set({ latency_ms: 200, embed_ms: 50 })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.tool.search.latency_ms': 200,
        'app.tool.search.embed_ms': 50,
      })
    }),
  },

  {
    name: 'model(name).set writes app.model.<name>.<key> only, with no app.<key> or app.time_to_first_token_ms',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.model('legal-analysis').set({ ttft_ms: 150, stream_total_ms: 3000, cited_chapters: 'Ch 5; Ch 8' })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.model.legal-analysis.ttft_ms': 150,
        'app.model.legal-analysis.stream_total_ms': 3000,
        'app.model.legal-analysis.cited_chapters': 'Ch 5; Ch 8',
      })
    }),
  },

  {
    name: 'agent(name).set writes app.agent.<name>.<key> only',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.agent('planner').set({ steps: 5, ttft_ms: 10 })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.agent.planner.steps': 5,
        'app.agent.planner.ttft_ms': 10,
      })
    }),
  },

  {
    name: 'node handles keep string, number, boolean and array values as given',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.tool('search').set({ text: 'a', count: 3, ratio: 0.5, flag: false, list: ['x', 'y'] })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.text'], 'a')
      assert.equal(attrs['app.tool.search.count'], 3)
      assert.equal(attrs['app.tool.search.ratio'], 0.5)
      assert.equal(attrs['app.tool.search.flag'], false)
      assert.deepEqual(attrs['app.tool.search.list'], ['x', 'y'])
      assert.equal(attrs['app.search.list'], undefined)
    }),
  },

  {
    name: 'set writes each key as given, with no prefix and no legacy key',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.set({ 'enduser.id': 'oid-123', 'app.custom': 'value', 'app.flag': true })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'enduser.id': 'oid-123',
        'app.custom': 'value',
        'app.flag': true,
      })
    }),
  },

  {
    name: 'a later write to the same key replaces the earlier value',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.set({ 'app.pii.latency_ms': 1 })
        fw.tool('pii').set({ latency_ms: 2 })
        fw.tool('pii').set({ latency_ms: 3 })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.pii.latency_ms': 1,
        'app.tool.pii.latency_ms': 3,
      })
    }),
  },

  {
    name: 'writes go to the active span only',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('parent', async () => {
        fw.set({ 'app.where': 'parent' })
        await sdk.inSpan('child', () => {
          fw.set({ 'app.where': 'child' })
          fw.tool('search').set({ latency_ms: 1 })
        })
      })
      assert.deepEqual(sdk.span('parent').attributes, { 'app.where': 'parent' })
      assert.deepEqual(sdk.span('child').attributes, {
        'app.where': 'child',
        'app.tool.search.latency_ms': 1,
      })
    }),
  },

  {
    name: 'with no active span, every write is dropped and getTraceId() is undefined',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      assert.equal(trace.getActiveSpan(), undefined)
      const idle = trace.getTracer('contract').startSpan('idle')
      fw.set({ 'app.x': 1 })
      fw.tool('search').set({ latency_ms: 1 })
      fw.model('legal-analysis').set({ ttft_ms: 1 })
      fw.agent('planner').set({ steps: 1 })
      idle.end()
      assert.equal(fw.getTraceId(), undefined)
      assert.deepEqual(sdk.span('idle').attributes, {})
    }),
  },

  {
    name: 'getTraceId() returns the trace ID of the active span',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      let traceId: string | undefined
      let seen: string | undefined
      await sdk.inSpan('request', (span) => {
        traceId = span.spanContext().traceId
        seen = fw.getTraceId()
      })
      assert.match(traceId ?? '', /^[0-9a-f]{32}$/)
      assert.equal(seen, traceId)
    }),
  },

  {
    name: 'metadata emits one INFO log record on the flywheel logger, named by microsoft.custom_event.name',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.metadata(TRACE_ID, 'user_feedback', { 'feedback.rating': 'down', 'feedback.count': 2 })
      const records = sdk.logRecords()
      assert.equal(records.length, 1)
      const [record] = records
      assert.deepEqual(record.attributes, {
        'microsoft.custom_event.name': 'user_feedback',
        'feedback.rating': 'down',
        'feedback.count': 2,
      })
      assert.equal(record.severityNumber, SeverityNumber.INFO)
      assert.equal(record.instrumentationScope.name, 'flywheel')
      assert.equal(record.body, undefined)
    }),
  },

  {
    name: 'metadata puts the record in the given trace, with the first 16 hex digits as its span ID',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.metadata(TRACE_ID, 'user_feedback', {})
      assert.deepEqual(sdk.logRecords()[0].spanContext, {
        traceId: TRACE_ID,
        spanId: TRACE_ID.slice(0, 16),
        traceFlags: TraceFlags.SAMPLED,
      })
    }),
  },

  {
    name: 'metadata uses the given trace ID, not the active span',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.metadata(TRACE_ID, 'tester_feedback', { 'tester.comment': 'ok' })
      })
      assert.equal(sdk.logRecords()[0].spanContext?.traceId, TRACE_ID)
      assert.deepEqual(sdk.span('request').attributes, {})
    }),
  },

  {
    name: 'metadata with a trace ID that is not 32 hex digits keeps the attributes and drops the trace',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.metadata('not-a-trace-id', 'user_feedback', { 'feedback.rating': 'up' })
      const [record] = sdk.logRecords()
      assert.equal(record.spanContext, undefined)
      assert.equal(record.attributes['feedback.rating'], 'up')
    }),
  },

  {
    name: 'an attribute named microsoft.custom_event.name replaces the event name',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.metadata(TRACE_ID, 'user_feedback', { 'microsoft.custom_event.name': 'other' })
      assert.equal(sdk.logRecords()[0].attributes['microsoft.custom_event.name'], 'other')
    }),
  },

  sync('aiSdkTelemetry() on the live instance turns AI SDK telemetry on, with inputs and outputs', () => {
    const fw = init()
    assert.deepEqual(fw.aiSdkTelemetry({ functionId: 'legal-analysis-query', metadata: { model: 'gpt-4.1' } }), {
      isEnabled: true,
      functionId: 'legal-analysis-query',
      recordInputs: true,
      recordOutputs: true,
      metadata: { model: 'gpt-4.1' },
    })
    assert.deepEqual(fw.aiSdkTelemetry(), {
      isEnabled: true,
      functionId: 'unknown',
      recordInputs: true,
      recordOutputs: true,
      metadata: {},
    })
  }),

  sync('aiSdkTelemetry() on the noop instance turns AI SDK telemetry off', () => {
    assert.deepEqual(noopInstance.aiSdkTelemetry({ functionId: 'legal-analysis-query', metadata: { model: 'gpt-4.1' } }), {
      isEnabled: false,
      functionId: 'legal-analysis-query',
      recordInputs: false,
      recordOutputs: false,
      metadata: { model: 'gpt-4.1' },
    })
    assert.deepEqual(noopInstance.aiSdkTelemetry(), {
      isEnabled: false,
      functionId: 'unknown',
      recordInputs: false,
      recordOutputs: false,
      metadata: {},
    })
  }),

  {
    name: 'flush() resolves to undefined on both instances',
    run: async () => {
      assert.equal(await init().flush(), undefined)
      assert.equal(await noopInstance.flush(), undefined)
    },
  },

  {
    name: 'the noop instance writes nothing, even inside an active span',
    run: () => withSdk(async (sdk) => {
      let traceId: string | undefined = 'unset'
      await sdk.inSpan('request', () => {
        noopInstance.set({ 'app.x': 1 })
        noopInstance.tool('search').set({ latency_ms: 1 })
        noopInstance.model('legal-analysis').set({ ttft_ms: 1 })
        noopInstance.agent('planner').set({ steps: 1 })
        noopInstance.metadata(TRACE_ID, 'user_feedback', { 'feedback.rating': 'up' })
        traceId = noopInstance.getTraceId()
      })
      assert.equal(traceId, undefined)
      assert.deepEqual(sdk.span('request').attributes, {})
      assert.equal(sdk.logRecords().length, 0)
    }),
  },

  {
    name: 'a schema handle writes declared keys as app.<type>.<name>.<key> only',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.tool('search', SEARCH_SCHEMA).set({ status: 'ok', result_count: 3, latency_ms: 12.5, cached: false, chapters: ['5', '8'] })
        fw.model('legal-analysis', { attributes: { ttft_ms: { type: 'number' } } }).set({ ttft_ms: 150 })
        fw.agent('planner', { attributes: { steps: { type: 'count' } } }).set({ steps: 2 })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.tool.search.status': 'ok',
        'app.tool.search.result_count': 3,
        'app.tool.search.latency_ms': 12.5,
        'app.tool.search.cached': false,
        'app.tool.search.chapters': ['5', '8'],
        'app.model.legal-analysis.ttft_ms': 150,
        'app.agent.planner.steps': 2,
      })
    }),
  },

  {
    name: 'a schema handle drops an undeclared key and names it in flywheel.attribute_error',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        const search = fw.tool('search', SEARCH_SCHEMA) as pkg.NodeHandle
        search.set({ result_count: 1, raw_query: 'my landlord' })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.raw_query'], undefined)
      assert.equal(attrs['app.search.raw_query'], undefined)
      assert.equal(attrs['app.tool.search.result_count'], 1)
      assert.deepEqual(attrs['flywheel.attribute_error'], ['app.tool.search.raw_query'])
    }),
  },

  {
    name: 'a schema handle drops an enum value outside the declared values and names the key',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        const search = fw.tool('search', SEARCH_SCHEMA) as pkg.NodeHandle
        search.set({ status: 'timeout' })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.status'], undefined)
      assert.equal(attrs['app.search.status'], undefined)
      assert.deepEqual(attrs['flywheel.attribute_error'], ['app.tool.search.status'])
    }),
  },

  {
    name: 'a schema handle drops a value of the wrong type, and a count that is not a non-negative integer',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        const search = fw.tool('search', SEARCH_SCHEMA) as pkg.NodeHandle
        search.set({ query: 42, cached: 'yes', latency_ms: 'fast', chapters: [1, 2] })
        search.set({ result_count: -1 })
        search.set({ result_count: 1.5 })
        search.set({ result_count: 'three results' })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'flywheel.attribute_error': [
          'app.tool.search.query',
          'app.tool.search.cached',
          'app.tool.search.latency_ms',
          'app.tool.search.chapters',
          'app.tool.search.result_count',
        ],
      })
    }),
  },

  {
    name: 'a schema handle cuts a string over the default limit of 1024 and sets <key>.truncated',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.tool('search', SEARCH_SCHEMA).set({ query: 'x'.repeat(2000) })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.query'], 'x'.repeat(1024))
      assert.equal(attrs['app.tool.search.query.truncated'], true)
      assert.equal(attrs['app.search.query'], undefined)
      assert.equal(attrs['flywheel.attribute_error'], undefined)
    }),
  },

  {
    name: 'a per-key maxLength overrides the schema maxLength, which overrides the default',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.agent('planner', {
          maxLength: 8,
          attributes: {
            goal: { type: 'string' },
            tag: { type: 'string', maxLength: 3 },
            steps: { type: 'string[]' },
            short: { type: 'string' },
          },
        }).set({ goal: 'find the time limit', tag: 'tenancy', steps: ['search', 'summarise'], short: 'ok' })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.agent.planner.goal': 'find the',
        'app.agent.planner.goal.truncated': true,
        'app.agent.planner.tag': 'ten',
        'app.agent.planner.tag.truncated': true,
        'app.agent.planner.steps': ['search', 'summaris'],
        'app.agent.planner.steps.truncated': true,
        'app.agent.planner.short': 'ok',
      })
    }),
  },

  {
    name: 'flywheel.attribute_error names each dropped key once, across writes on one span',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        const search = fw.tool('search', SEARCH_SCHEMA) as pkg.NodeHandle
        search.set({ status: 'bad' })
        search.set({ status: 'worse', extra: 1 })
        search.set({ status: 'ok' })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.status'], 'ok')
      assert.deepEqual(attrs['flywheel.attribute_error'], ['app.tool.search.status', 'app.tool.search.extra'])
    }),
  },

  {
    name: 'in strict mode, an invalid write throws and writes nothing for that key',
    run: () => withSdk(async (sdk) => {
      const fw = init({ strict: true })
      await sdk.inSpan('request', () => {
        const search = fw.tool('search', SEARCH_SCHEMA) as pkg.NodeHandle
        assert.throws(() => search.set({ status: 'timeout' }), /app\.tool\.search\.status/)
        assert.throws(() => search.set({ raw_query: 'x' }), /app\.tool\.search\.raw_query/)
        assert.throws(() => fw.user(''), /enduser\.id/)
        search.set({ query: 'x'.repeat(2000) })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.status'], undefined)
      assert.equal(attrs['app.tool.search.query.truncated'], true)
    }),
  },

  {
    name: 'a rename writes the old and new names before its expiry date, and only the new name from that date',
    run: () => withSdk(async (sdk) => {
      const schema = {
        attributes: {
          time_to_first_token_ms: { type: 'number', renamedFrom: { from: 'ttft_ms', until: '2026-12-01' } },
        },
      } as const satisfies NodeSchema
      await sdk.inSpan('before', () => {
        init({ now: at('2026-11-30T23:59:59Z') }).agent('planner', schema).set({ time_to_first_token_ms: 10 })
      })
      await sdk.inSpan('on', () => {
        init({ now: at('2026-12-01T00:00:00Z') }).agent('planner', schema).set({ time_to_first_token_ms: 20 })
      })
      assert.deepEqual(sdk.span('before').attributes, {
        'app.agent.planner.time_to_first_token_ms': 10,
        'app.agent.planner.ttft_ms': 10,
      })
      assert.deepEqual(sdk.span('on').attributes, {
        'app.agent.planner.time_to_first_token_ms': 20,
      })
    }),
  },

  {
    name: 'a rename sets <key>.truncated on both names when it cuts the value',
    run: () => withSdk(async (sdk) => {
      const fw = init({ now: at('2026-01-01T00:00:00Z') })
      await sdk.inSpan('request', () => {
        fw.agent('planner', {
          attributes: { goal: { type: 'string', maxLength: 2, renamedFrom: { from: 'objective', until: '2026-12-01' } } },
        }).set({ goal: 'abc' })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.agent.planner.goal': 'ab',
        'app.agent.planner.goal.truncated': true,
        'app.agent.planner.objective': 'ab',
        'app.agent.planner.objective.truncated': true,
      })
    }),
  },

  {
    name: 'a schema handle infers the allowed keys and value types',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        const search = fw.tool('search', SEARCH_SCHEMA)
        search.set({ status: 'empty', result_count: 0 })
        // @ts-expect-error: an undeclared key is a type error
        search.set({ raw_query: 'x' })
        // @ts-expect-error: a value outside the enum is a type error
        search.set({ status: 'timeout' })
        // @ts-expect-error: a string where a count goes is a type error
        search.set({ result_count: 'three' })
      })
      const attrs = sdk.span('request').attributes
      assert.equal(attrs['app.tool.search.status'], 'empty')
      assert.equal(attrs['app.tool.search.result_count'], 0)
    }),
  },

  {
    name: 'user(id) and session(id) set enduser.id and session.id on the active span',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('parent', async () => {
        await sdk.inSpan('request', () => {
          fw.user('u-7f3a')
          fw.session('s-91c2')
        })
      })
      assert.deepEqual(sdk.span('request').attributes, { 'enduser.id': 'u-7f3a', 'session.id': 's-91c2' })
      assert.deepEqual(sdk.span('parent').attributes, {})
    }),
  },

  {
    name: 'user() and session() drop an empty or non-string id and name the key in flywheel.attribute_error',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.user('')
        fw.session(42 as unknown as string)
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'flywheel.attribute_error': ['enduser.id', 'session.id'],
      })
    }),
  },

  {
    name: 'with no active span, schema handles, user() and session() write nothing and do not throw',
    run: () => withSdk(async (sdk) => {
      const fw = init({ strict: true })
      const idle = trace.getTracer('contract').startSpan('idle')
      ;(fw.tool('search', SEARCH_SCHEMA) as pkg.NodeHandle).set({ status: 'timeout' })
      fw.user('u-1')
      fw.session('s-1')
      idle.end()
      assert.deepEqual(sdk.span('idle').attributes, {})
    }),
  },

  {
    name: 'the noop instance accepts a schema, user() and session(), and writes nothing',
    run: () => withSdk(async (sdk) => {
      await sdk.inSpan('request', () => {
        noopInstance.tool('search', SEARCH_SCHEMA).set({ status: 'ok' })
        noopInstance.user('u-1')
        noopInstance.session('s-1')
      })
      assert.deepEqual(sdk.span('request').attributes, {})
    }),
  },

  sync('a timeline records spans as offsets from its start, in start order', () => {
    const clock = fakeClock()
    const tl = init().createTimeline(clock.now)
    clock.advance(5)
    const b = tl.open('b')
    clock.advance(10)
    tl.close(b, { n: 1 })
    const a = tl.open('a')
    clock.advance(2.25)
    tl.close(a)
    assert.deepEqual(tl.toJSON().spans, [
      { name: 'b', startMs: 5, endMs: 15, attrs: { n: 1 } },
      { name: 'a', startMs: 15, endMs: 17.3 },
    ])
  }),

  sync('a repeated span name gets a #n suffix, and a span still open is left out', () => {
    const tl = init().createTimeline(fakeClock().now)
    tl.close(tl.open('chat.request'))
    tl.close(tl.open('chat.request'))
    tl.open('never.closed')
    assert.deepEqual(tl.toJSON().spans.map(s => s.name), ['chat.request', 'chat.request#2'])
  }),

  sync('mark keeps the first time, markLast keeps the last, and set drops a value that is not finite', () => {
    const clock = fakeClock()
    const tl = init().createTimeline(clock.now)
    clock.advance(1)
    tl.mark('first')
    tl.markLast('last')
    clock.advance(1)
    tl.mark('first')
    tl.markLast('last')
    tl.set('tokens', 12)
    tl.set('rate', Number.NaN)
    assert.deepEqual(tl.toJSON().marks, { first: 1, last: 2 })
    assert.deepEqual(tl.toJSON().usage, { tokens: 12 })
  }),

  {
    name: 'timeline() records nothing outside a request',
    run: async () => {
      const fw = init()
      const tl = fw.timeline()
      tl.span('x')()
      tl.mark('m')
      tl.annotate({ a: 1 })
      assert.equal(await tl.timed('t', () => 7), 7)
      assert.equal(tl.scope('s', () => 8), 8)
      assert.equal(await fw.timed('t', () => 9), 9)
    },
  },

  {
    name: 'timed spans take the scope as a prefix, across awaits and parallel work',
    run: async () => {
      const fw = init()
      const rt = fw.createTimeline()
      await fw.runWithTimeline(rt, async () => {
        await Promise.all([0, 1].map(i => fw.timed(`leg.${i}`, async () => {
          await sleep(1)
          await fw.timeline().timed('embed', async () => {
            fw.timeline().span('request')()
            fw.timeline().annotate({ leg: i })
          })
        })))
        fw.timeline().scope('chat', () => fw.timeline().span('request')())
      })
      const spans = rt.toJSON().spans
      assert.deepEqual(spans.map(s => s.name).sort(), [
        'chat.request',
        'leg.0', 'leg.0.embed', 'leg.0.embed.request',
        'leg.1', 'leg.1.embed', 'leg.1.embed.request',
      ])
      assert.deepEqual(spans.find(s => s.name === 'leg.1.embed')?.attrs, { leg: 1 })
    },
  },

  {
    name: 'a timed span closes when its work throws',
    run: async () => {
      const fw = init()
      const rt = fw.createTimeline()
      await assert.rejects(
        fw.runWithTimeline(rt, () => fw.timed('fails', async () => { throw new Error('boom') })),
        /boom/,
      )
      assert.deepEqual(rt.toJSON().spans.map(s => s.name), ['fails'])
    },
  },

  {
    name: 'sequential step offsets add up to the request time on a fake clock',
    run: async () => {
      const fw = init()
      const clock = fakeClock()
      const rt = fw.createTimeline(clock.now)
      rt.startRequest()
      await fw.runWithTimeline(rt, async () => {
        for (const [name, ms] of [['pii', 120], ['search', 500.5], ['chat', 3000]] as const) {
          await fw.timed(name, () => clock.advance(ms))
        }
      })
      rt.endRequest()
      const [request, ...steps] = rt.toJSON().spans
      assert.deepEqual(request, { name: 'request', startMs: 0, endMs: 3620.5 })
      assert.deepEqual(steps, [
        { name: 'pii', startMs: 0, endMs: 120 },
        { name: 'search', startMs: 120, endMs: 620.5 },
        { name: 'chat', startMs: 620.5, endMs: 3620.5 },
      ])
      const sum = steps.reduce((total, s) => total + (s.endMs - s.startMs), 0)
      assert.equal(sum, request.endMs - request.startMs)
    },
  },

  {
    name: 'sequential step offsets add up to the request wall-clock time on the real clock',
    run: async () => {
      const fw = init()
      const before = performance.now()
      const rt = fw.createTimeline()
      rt.startRequest()
      await fw.runWithTimeline(rt, async () => {
        for (const name of ['pii', 'search', 'chat']) await fw.timed(name, () => sleep(5))
      })
      rt.endRequest()
      const wall = performance.now() - before
      const [request, ...steps] = rt.toJSON().spans
      assert.equal(request.name, 'request')
      assert.equal(request.startMs, 0)
      assert.deepEqual(steps.map(s => s.name), ['pii', 'search', 'chat'])
      for (let i = 1; i < steps.length; i++) assert.ok(steps[i].startMs >= steps[i - 1].endMs)
      const sum = steps.reduce((total, s) => total + (s.endMs - s.startMs), 0)
      // Each offset rounds to 0.1 ms, and a few microseconds pass between steps.
      assert.ok(Math.abs(request.endMs - sum) <= 1, `request ${request.endMs} ms, steps ${sum} ms`)
      assert.ok(request.endMs <= wall + 0.1, `request ${request.endMs} ms, wall clock ${wall} ms`)
    },
  },

  sync('startTimeline starts the clock, and timedMiddleware times a middleware and restores the timeline in next', () => {
    const response = fakeResponse()
    let seen: ReturnType<typeof requestTimeline>
    // A body parser calls next from a stream callback, outside the context.
    const detached: RequestHandler = (_req, _res, next) => { next() }
    startTimeline(fakeRequest, response, () => {
      timedMiddleware('middleware.json', detached)(fakeRequest, response, (() => {
        init().timeline().span('handler')()
        seen = requestTimeline(response)
      }) as NextFunction)
    })
    assert.ok(seen)
    assert.deepEqual(seen.toJSON().spans.map(s => s.name), ['middleware.json', 'handler'])
  }),

  sync('startTimeline opens a request span at zero that closes on endRequest, once', () => {
    const response = fakeResponse()
    startTimeline(fakeRequest, response, () => {
      init().timeline().span('respond.done')()
    })
    const rt = requestTimeline(response)
    assert.ok(rt)
    assert.deepEqual(rt.toJSON().spans.map(s => s.name), ['respond.done'])
    rt.endRequest()
    const [request, done] = rt.toJSON().spans
    rt.endRequest()
    assert.deepEqual(rt.toJSON().spans[0], request)
    assert.equal(request.name, 'request')
    assert.equal(request.startMs, 0)
    assert.ok(request.endMs >= done.endMs)
  }),

  sync('timedMiddleware passes a middleware error to next', () => {
    const response = fakeResponse()
    let got: unknown
    startTimeline(fakeRequest, response, () => {
      timedMiddleware('m', (_q, _s, next) => next(new Error('bad')))(
        fakeRequest, response, ((err: unknown) => { got = err }) as NextFunction,
      )
    })
    assert.ok(got instanceof Error)
  }),

  sync('timedMiddleware runs the middleware untimed when no timeline is attached', () => {
    let called = false
    timedMiddleware('m', (_q, _s, next) => next())(fakeRequest, fakeResponse(), (() => { called = true }) as NextFunction)
    assert.equal(called, true)
  }),

  sync('recordStreamPart marks the first chunk, first text, reasoning, the tool input window and the last token', () => {
    const fw = init()
    const clock = fakeClock(0)
    const rt = fw.createTimeline(clock.now)
    const tools = new Map<string, string>()
    const parts = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'reasoning-start' },
      { type: 'reasoning-delta' },
      { type: 'reasoning-end' },
      { type: 'text-delta' },
      { type: 'text-delta' },
      { type: 'tool-input-start', id: 't1', toolName: 'analysis_data' },
      { type: 'tool-input-delta', id: 't1' },
      { type: 'tool-input-end', id: 't1' },
      { type: 'tool-call', toolName: 'analysis_data' },
    ]
    fw.runWithTimeline(rt, () => {
      for (const part of parts) {
        clock.advance(10)
        recordStreamPart(fw.timeline(), part, tools)
      }
    })
    assert.deepEqual(rt.toJSON().marks, {
      'chat.firstChunk': 30,
      'chat.reasoning.start': 30,
      'chat.reasoning.end': 50,
      'chat.firstText': 60,
      'chat.lastToken': 90,
      'chat.tool.analysis_data.inputStart': 80,
      'chat.tool.analysis_data.inputEnd': 100,
    })
  }),

  sync('recordUsage records token counts and output tokens per second over the visible stream', () => {
    const fw = init()
    const rt = fw.createTimeline()
    fw.runWithTimeline(rt, () => fw.recordUsage(fw.timeline(), {
      inputTokens: 5000,
      outputTokens: 700,
      inputTokenDetails: { cacheReadTokens: 1024 },
      outputTokenDetails: { reasoningTokens: 200 },
    }, { 'chat.firstText': 1000, 'chat.tool.analysis_data.inputStart': 1500, 'chat.lastToken': 3000 }))
    assert.deepEqual(rt.toJSON().usage, {
      inputTokens: 5000,
      outputTokens: 700,
      reasoningTokens: 200,
      cachedInputTokens: 1024,
      // 500 visible tokens over 2 seconds.
      outputTokensPerSecond: 250,
    })
  }),

  sync('recordUsage leaves out the rate when no visible token was marked', () => {
    const fw = init()
    const rt = fw.createTimeline()
    fw.runWithTimeline(rt, () => fw.recordUsage(fw.timeline(), { inputTokens: 10, outputTokens: 0 }, {}))
    assert.deepEqual(rt.toJSON().usage, { inputTokens: 10, outputTokens: 0 })
  }),

  sync('timelineAttributes flattens the timeline into app.timeline.* attributes', () => {
    assert.deepEqual(init().timelineAttributes({
      spans: [{ name: 'search.leg.0.azure', startMs: 100, endMs: 350.5, attrs: { elapsedTimeMs: 98, semanticRanker: true } }],
      marks: { 'chat.firstText': 2100 },
      usage: { outputTokens: 700 },
    }), {
      'app.timeline.search.leg.0.azure.start_ms': 100,
      'app.timeline.search.leg.0.azure.ms': 250.5,
      'app.timeline.search.leg.0.azure.attr.elapsedTimeMs': 98,
      'app.timeline.search.leg.0.azure.attr.semanticRanker': true,
      'app.timeline.mark.chat.firstText': 2100,
      'app.timeline.usage.outputTokens': 700,
    })
  }),

  {
    name: 'the response payload and the request span hold the same timeline',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      const clock = fakeClock()
      const rt = fw.createTimeline(clock.now)
      let payload: ReturnType<typeof rt.toJSON> | undefined
      await sdk.inSpan('request', async () => {
        await fw.runWithTimeline(rt, async () => {
          await fw.timed('search', () => clock.advance(40))
          fw.timeline().mark('respond.firstText')
        })
        payload = rt.toJSON()
        fw.set(fw.timelineAttributes(payload))
      })
      assert.deepEqual(payload, {
        spans: [{ name: 'search', startMs: 0, endMs: 40 }],
        marks: { 'respond.firstText': 40 },
        usage: {},
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.timeline.search.start_ms': 0,
        'app.timeline.search.ms': 40,
        'app.timeline.mark.respond.firstText': 40,
      })
    }),
  },

  {
    name: 'the noop instance keeps the clock, and writes no attributes',
    run: () => withSdk(async (sdk) => {
      const clock = fakeClock()
      const rt = noopInstance.createTimeline(clock.now)
      await sdk.inSpan('request', async () => {
        await noopInstance.runWithTimeline(rt, () => noopInstance.timed('search', () => clock.advance(10)))
        noopInstance.set(noopInstance.timelineAttributes(rt.toJSON()))
      })
      assert.deepEqual(rt.toJSON().spans, [{ name: 'search', startMs: 0, endMs: 10 }])
      assert.deepEqual(sdk.span('request').attributes, {})
    }),
  },

  {
    name: 'turnRef() returns the trace ID and span ID of the active span',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      let ref: TurnRef | undefined
      await sdk.inSpan('request', () => { ref = fw.turnRef() })
      const ctx = sdk.span('request').spanContext()
      assert.deepEqual(ref, { traceId: ctx.traceId, spanId: ctx.spanId })
    }),
  },

  {
    name: 'turnRef() is undefined with no active span',
    run: () => withSdk(async () => {
      assert.equal(init().turnRef(), undefined)
    }),
  },

  {
    name: 'feedback joins its turn\'s trace as a child of the turn span',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      const ref = await turn(sdk, fw)
      fw.feedback({ kind: 'rating', name: 'user_feedback', turn: ref, rating: 'up' })
      const span = sdk.span('user_feedback')
      assert.equal(span.spanContext().traceId, ref.traceId)
      assert.equal(span.parentSpanContext?.spanId, ref.spanId)
      assert.equal(span.parentSpanContext?.spanId, sdk.span('turn').spanContext().spanId)
      assert.equal(span.kind, SpanKind.INTERNAL)
      assert.equal(span.instrumentationScope.name, 'flywheel')
    }),
  },

  {
    name: 'feedback joins its turn, not the span active when it is written',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('feedback-request', () => {
        fw.feedback({ kind: 'rating', name: 'user_feedback', turn: TURN, rating: 'down' })
      })
      const span = sdk.span('user_feedback')
      assert.equal(span.spanContext().traceId, TURN.traceId)
      assert.equal(span.parentSpanContext?.spanId, TURN.spanId)
      assert.deepEqual(sdk.span('feedback-request').attributes, {})
    }),
  },

  {
    name: 'a rating writes event.name and the feedback.* attributes FLS queries read',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({
        kind: 'rating', name: 'user_feedback', turn: TURN, session: 's1',
        rating: 'down', reason: 'wrong', reasons: ['wrong', 'slow'], comment: 'no',
        subject: { kind: 'answer', id: 'a1' }, actor: { id: 'u1', kind: 'person' },
        attributes: { 'app.audience': 'staff' },
      })
      assert.deepEqual(sdk.span('user_feedback').attributes, {
        'event.name': 'user_feedback',
        'feedback.kind': 'rating',
        'feedback.class': 'explicit',
        'feedback.session': 's1',
        'feedback.rating': 'down',
        'feedback.reason': 'wrong',
        'feedback.reasons': 'wrong,slow',
        'feedback.comment': 'no',
        'feedback.subject.kind': 'answer',
        'feedback.subject.id': 'a1',
        'feedback.actor.id': 'u1',
        'feedback.actor.kind': 'person',
        'app.audience': 'staff',
      })
    }),
  },

  {
    name: 'namespace writes the typed attributes under its prefix, so tester ratings keep tester.*',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({
        kind: 'rating', name: 'tester_feedback', turn: TURN, session: 's1', namespace: 'tester',
        ratings: { faithfulness: 4, relevance: 5 }, comment: 'ok',
        attributes: { 'tester.question': 'q' },
      })
      assert.deepEqual(sdk.span('tester_feedback').attributes, {
        'event.name': 'tester_feedback',
        'tester.kind': 'rating',
        'tester.class': 'explicit',
        'tester.session': 's1',
        'tester.rating.faithfulness': 4,
        'tester.rating.relevance': 5,
        'tester.comment': 'ok',
        'tester.question': 'q',
      })
    }),
  },

  {
    name: 'each behaviour signal writes its kind, its ADR 005 class and its typed attributes',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      const base = { turn: TURN, session: 's1' }
      fw.feedback({ ...base, kind: 'decision', decision: 'reject', reason: 'off-topic' })
      fw.feedback({ ...base, kind: 'edit', draft: 'agent text', text: 'person text' })
      fw.feedback({ ...base, kind: 'dwell', element: 'sources', dwellMs: 1500 })
      fw.feedback({ ...base, kind: 'next_message', text: 'that is wrong' })
      const common = (kind: string, cls: string) => ({
        'event.name': `feedback.${kind}`, 'feedback.kind': kind, 'feedback.class': cls, 'feedback.session': 's1',
      })
      assert.deepEqual(sdk.span('feedback.decision').attributes, {
        ...common('decision', 'decision'), 'feedback.decision': 'reject', 'feedback.reason': 'off-topic',
      })
      assert.deepEqual(sdk.span('feedback.edit').attributes, {
        ...common('edit', 'decision'), 'feedback.edit.draft': 'agent text', 'feedback.edit.text': 'person text',
      })
      assert.deepEqual(sdk.span('feedback.dwell').attributes, {
        ...common('dwell', 'ui'), 'feedback.element': 'sources', 'feedback.dwell_ms': 1500,
      })
      assert.deepEqual(sdk.span('feedback.next_message').attributes, {
        ...common('next_message', 'conversation'), 'feedback.next_message': 'that is wrong',
      })
    }),
  },

  {
    name: 'an attribute cannot replace event.name',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({ kind: 'rating', name: 'user_feedback', turn: TURN, rating: 'up', attributes: { 'event.name': 'other' } })
      assert.equal(sdk.span('user_feedback').attributes['event.name'], 'user_feedback')
    }),
  },

  {
    name: 'feedback with no turn ref joins one trace per session, the same for every event in it',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({ kind: 'dwell', name: 'a', session: 's1', element: 'x', dwellMs: 1 })
      fw.feedback({ kind: 'dwell', name: 'b', session: 's1', element: 'y', dwellMs: 2 })
      fw.feedback({ kind: 'dwell', name: 'c', session: 's2', element: 'x', dwellMs: 1 })
      const [a, b, c] = ['a', 'b', 'c'].map(n => sdk.span(n))
      assert.match(a.spanContext().traceId, /^[0-9a-f]{32}$/)
      assert.equal(a.spanContext().traceId, b.spanContext().traceId)
      assert.equal(a.parentSpanContext?.spanId, b.parentSpanContext?.spanId)
      assert.notEqual(a.spanContext().traceId, c.spanContext().traceId)
      assert.equal(a.attributes['feedback.session'], 's1')
    }),
  },

  {
    name: 'feedback with an invalid turn ref joins its session\'s trace',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({ kind: 'rating', name: 'bad', session: 's1', turn: { traceId: 'nope', spanId: 'nope' }, rating: 'up' })
      fw.feedback({ kind: 'rating', name: 'none', session: 's1', rating: 'up' })
      assert.equal(sdk.span('bad').spanContext().traceId, sdk.span('none').spanContext().traceId)
    }),
  },

  {
    name: 'feedback with no turn ref and no session joins one trace for the process',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({ kind: 'rating', name: 'a', rating: 'up' })
      fw.feedback({ kind: 'rating', name: 'b', rating: 'up' })
      const a = sdk.span('a')
      assert.equal(a.spanContext().traceId, sdk.span('b').spanContext().traceId)
      assert.match(String(a.attributes['feedback.session']), /^process-[0-9a-f]{8}$/)
    }),
  },

  {
    name: 'feedback starts and ends its span at the at time',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      const at = '2026-10-01T00:00:00.000Z'
      fw.feedback({ kind: 'rating', name: 'user_feedback', turn: TURN, rating: 'up', at })
      const span = sdk.span('user_feedback')
      const ms = Date.parse(at)
      assert.deepEqual(span.startTime, [Math.floor(ms / 1000), (ms % 1000) * 1e6])
      assert.deepEqual(span.endTime, span.startTime)
    }),
  },

  {
    name: 'feedback writes no log record by default',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      fw.feedback({ kind: 'rating', name: 'user_feedback', turn: TURN, rating: 'up' })
      assert.equal(sdk.spans().length, 1)
      assert.equal(sdk.logRecords().length, 0)
    }),
  },

  {
    name: 'with azureCustomEvents, feedback also emits a log record named by microsoft.custom_event.name, in the feedback span',
    run: () => withSdk(async (sdk) => {
      const fw = init({ azureCustomEvents: true })
      fw.feedback({ kind: 'rating', name: 'user_feedback', turn: TURN, session: 's1', rating: 'down' })
      const span = sdk.span('user_feedback')
      const records = sdk.logRecords()
      assert.equal(records.length, 1)
      const [record] = records
      assert.deepEqual(record.attributes, { ...span.attributes, 'microsoft.custom_event.name': 'user_feedback' })
      assert.equal(record.spanContext?.traceId, TURN.traceId)
      assert.equal(record.spanContext?.spanId, span.spanContext().spanId)
      assert.equal(record.severityNumber, SeverityNumber.INFO)
      assert.equal(record.instrumentationScope.name, 'flywheel')
      assert.deepEqual(record.hrTime, span.startTime)
    }),
  },

  {
    name: 'the noop instance drops feedback, and its turnRef() is undefined',
    run: () => withSdk(async (sdk) => {
      let ref: TurnRef | undefined = TURN
      await sdk.inSpan('request', () => {
        noopInstance.feedback({ kind: 'rating', name: 'user_feedback', turn: TURN, rating: 'up' })
        ref = noopInstance.turnRef()
      })
      assert.equal(ref, undefined)
      assert.deepEqual(sdk.spans().map(s => s.name), ['request'])
      assert.equal(sdk.logRecords().length, 0)
    }),
  },
]

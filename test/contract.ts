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
import { trace, TraceFlags } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import * as pkg from '../src/index.js'
import { init, flywheel, noopInstance, LEGACY_EXPIRY } from '../src/index.js'
import { withSdk } from './sdk.js'

export interface ContractCase {
  name: string
  run: () => Promise<void>
}

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'

const sync = (name: string, fn: () => void): ContractCase => ({ name, run: async () => fn() })

export const contractCases: ContractCase[] = [
  // Must stay first. See the header.
  sync('flywheel() returns the noop instance before init()', () => {
    assert.equal(flywheel(), noopInstance)
  }),

  sync('the package exports init, flywheel, noopInstance and LEGACY_EXPIRY', () => {
    assert.deepEqual(Object.keys(pkg).sort(), ['LEGACY_EXPIRY', 'flywheel', 'init', 'noopInstance'])
  }),

  sync('LEGACY_EXPIRY is 2026-09-18', () => {
    assert.equal(LEGACY_EXPIRY, '2026-09-18')
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
    name: 'tool(name).set writes app.tool.<name>.<key> and the legacy app.<name>.<key>',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.tool('search').set({ latency_ms: 200, embed_ms: 50 })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.tool.search.latency_ms': 200,
        'app.search.latency_ms': 200,
        'app.tool.search.embed_ms': 50,
        'app.search.embed_ms': 50,
      })
    }),
  },

  {
    name: 'model(name).set writes app.model.<name>.<key> and the legacy app.<key>, with ttft_ms renamed',
    run: () => withSdk(async (sdk) => {
      const fw = init()
      await sdk.inSpan('request', () => {
        fw.model('legal-analysis').set({ ttft_ms: 150, stream_total_ms: 3000, cited_chapters: 'Ch 5; Ch 8' })
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.model.legal-analysis.ttft_ms': 150,
        'app.time_to_first_token_ms': 150,
        'app.model.legal-analysis.stream_total_ms': 3000,
        'app.stream_total_ms': 3000,
        'app.model.legal-analysis.cited_chapters': 'Ch 5; Ch 8',
        'app.cited_chapters': 'Ch 5; Ch 8',
      })
    }),
  },

  {
    name: 'agent(name).set writes app.agent.<name>.<key> only, with no legacy key',
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
      assert.deepEqual(attrs['app.search.list'], ['x', 'y'])
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
      })
      assert.deepEqual(sdk.span('request').attributes, {
        'app.pii.latency_ms': 2,
        'app.tool.pii.latency_ms': 2,
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
        'app.search.latency_ms': 1,
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
]

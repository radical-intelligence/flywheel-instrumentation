/**
 * Boots the example agent in `examples/agent/` with in-memory exporters,
 * sends one `/chat` and one `/feedback`, and reads the exported spans.
 *
 * The example imports the package by its name, which resolves to `dist/`,
 * so this file needs `npm run build` first. node:test runs each test file in
 * its own process, so the `init()` here does not touch the contract suite.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import type { TurnRef } from '../src/index.js'
import { start } from '../examples/agent/main.js'
import type { Started } from '../examples/agent/main.js'

const spans = new InMemorySpanExporter()
let agent: Started
let ref: TurnRef
let answer: string

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${agent.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** The one ended span with this name. The turn span ends just after the response, so wait for it. */
async function span(name: string): Promise<ReadableSpan> {
  for (let i = 0; i < 50; i++) {
    const found = spans.getFinishedSpans().filter(s => s.name === name)
    if (found.length === 1) return found[0]
    if (found.length > 1) throw new Error(`expected one span named ${name}, found ${found.length}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`no span named ${name}`)
}

/** True when `ancestorId` is on the parent chain of `s`. */
function descends(s: ReadableSpan, ancestorId: string): boolean {
  const byId = new Map(spans.getFinishedSpans().map(x => [x.spanContext().spanId, x]))
  for (let p = s.parentSpanContext?.spanId; p; p = byId.get(p)?.parentSpanContext?.spanId) {
    if (p === ancestorId) return true
  }
  return false
}

before(async () => {
  agent = await start({ spanExporter: spans, logExporter: new InMemoryLogRecordExporter() })
  const chat = await post('/chat', { message: 'What are the opening hours?', conversationId: 'example-1' })
  assert.equal(chat.status, 200)
  const body = await chat.json() as { answer: string; turn: TurnRef }
  ref = body.turn
  answer = body.answer
  const feedback = await post('/feedback', { turn: ref, rating: 'up', comment: 'clear' })
  assert.equal(feedback.status, 204)
})

after(async () => {
  agent.server.close()
  await agent.telemetry.shutdown()
})

test('the self-check is ok and emits flywheel.startup', () => {
  assert.equal(agent.report.ok, true)
  assert.deepEqual(agent.report.issues, [])
  assert.ok(spans.getFinishedSpans().some(s => s.name === 'flywheel.startup'))
})

test('the turn root span carries the turn record, and /chat returns its ref', async () => {
  const turn = await span('invoke_agent example-agent')
  assert.equal(turn.parentSpanContext, undefined)
  assert.deepEqual(ref, { traceId: turn.spanContext().traceId, spanId: turn.spanContext().spanId })
  const a = turn.attributes
  assert.equal(a['gen_ai.agent.name'], 'example-agent')
  assert.equal(a['gen_ai.conversation.id'], 'example-1')
  assert.equal(a['app.turn.outcome'], 'answered')
  assert.equal(a['app.turn.query'], 'What are the opening hours?')
  assert.equal(a['app.turn.answer'], answer)
  assert.equal(a['app.turn.tool_called'], true)
  assert.equal(a['app.turn.message_count'], 4)
  assert.equal(a['app.turn.guardrail.used_lookup.passed'], true)
  assert.equal(a['gen_ai.request.model'], 'mock-model')
  assert.equal(a['app.model.answer.finish_reason'], 'stop')
  assert.equal(a['app.model.answer.step_count'], 2)
  const messages = JSON.parse(String(a['app.turn.messages'])) as { role: string }[]
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant'])
})

test('the model and tool spans are in the turn, under the turn span', async () => {
  const turn = await span('invoke_agent example-agent')
  const model = await span('ai.streamText')
  const tool = await span('ai.toolCall')
  assert.equal(model.parentSpanContext?.spanId, turn.spanContext().spanId)
  assert.ok(descends(tool, turn.spanContext().spanId))
  assert.equal(tool.attributes['app.tool.lookup.status'], 'ok')
  assert.equal(tool.attributes['app.tool.lookup.result_count'], 1)
})

test('the turn span carries the request timeline and the timings it fills', async () => {
  const a = (await span('invoke_agent example-agent')).attributes
  for (const key of [
    'app.timeline.request.ms',
    'app.timeline.parse.ms',
    'app.timeline.chat.ms',
    'app.timeline.chat.tool.lookup.ms',
    'app.timeline.mark.chat.firstChunk',
    'app.timeline.mark.chat.lastToken',
    'app.timeline.usage.outputTokens',
    'app.turn.timing.chat',
  ]) {
    assert.equal(typeof a[key], 'number', key)
  }
  assert.equal(a['gen_ai.usage.output_tokens'], a['app.timeline.usage.outputTokens'])
})

test('the feedback span is a child of the turn span', async () => {
  const turn = await span('invoke_agent example-agent')
  const feedback = await span('user_feedback')
  assert.equal(feedback.spanContext().traceId, turn.spanContext().traceId)
  assert.equal(feedback.parentSpanContext?.spanId, turn.spanContext().spanId)
  assert.equal(feedback.attributes['feedback.rating'], 'up')
  assert.equal(feedback.attributes['feedback.comment'], 'clear')
})

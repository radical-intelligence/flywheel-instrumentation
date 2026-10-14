/**
 * The HTTP routes of the example agent.
 *
 * - `POST /chat` runs one agent turn. The body is `{ message, conversationId? }`.
 *   The response holds the answer and the turn ref.
 * - `POST /feedback` rates a turn. The body is `{ turn, rating, comment? }`,
 *   where `turn` is the ref that `/chat` returned.
 *
 * The routes call `flywheel()`, which returns the instance that `init()`
 * made in `main.ts`. The example imports the package by its name, as a
 * product does. In this repository that name resolves to `dist/`, so run
 * `npm run build` first.
 */
import express from 'express'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { flywheel } from '@radical-intelligence/flywheel-instrumentation'
import type { TurnMessage, TurnRef } from '@radical-intelligence/flywheel-instrumentation'
import { requestTimeline, startTimeline, timedMiddleware } from '@radical-intelligence/flywheel-instrumentation/express'
import { recordStreamPart } from '@radical-intelligence/flywheel-instrumentation/ai-sdk'
import { createModel } from './model.js'
import { ANSWER_SCHEMA, LOOKUP_SCHEMA } from './schemas.js'

const AGENT = 'example-agent'

/** The data the `lookup` tool searches. */
const FACTS = [
  { topic: 'opening hours', text: 'The office opens from 09:00 to 17:00, Monday to Friday.' },
  { topic: 'parking', text: 'Visitor parking is on level 2.' },
  { topic: 'wifi', text: 'The guest network is example-guest.' },
]

const lookup = tool({
  description: 'Find office facts whose topic is in the question.',
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }) => {
    const fw = flywheel()
    // A timeline span for the tool (practice 2).
    return fw.timed('tool.lookup', () => {
      const text = topic.toLowerCase()
      const found = FACTS.filter(f => text.includes(f.topic)).map(f => f.text)
      // Practice 3: a schema handle writes app.tool.lookup.* on the active
      // span, which is the AI SDK `ai.toolCall` span. A count stands in for
      // the results.
      fw.tool('lookup', LOOKUP_SCHEMA).set({ status: found.length > 0 ? 'ok' : 'empty', result_count: found.length, topic })
      return found
    })
  },
})

function isTurnRef(value: unknown): value is TurnRef {
  const ref = value as Partial<TurnRef> | undefined
  return typeof ref?.traceId === 'string' && typeof ref.spanId === 'string'
}

export function createApp(): express.Express {
  const { model, modelName } = createModel()
  const app = express()

  // Practice 2: the clock starts first, and each middleware is a timeline span.
  app.use(startTimeline)
  app.use(timedMiddleware('parse', express.json()))

  app.post('/chat', async (req, res) => {
    const fw = flywheel()
    const tl = requestTimeline(res) ?? fw.createTimeline()
    const message: unknown = req.body?.message
    const conversationId: unknown = req.body?.conversationId
    if (typeof message !== 'string' || message.length === 0) {
      res.status(400).json({ error: 'message must be a non-empty string' })
      return
    }
    const conversation = typeof conversationId === 'string' ? conversationId : undefined

    // Practice 1: one root span and one record per turn. The AI SDK spans
    // inside it are its children. The timeline fills the timings and usage.
    await fw.turn({ agent: AGENT, conversationId: conversation, model: modelName, timeline: tl }, async (turn) => {
      if (conversation) fw.session(conversation)
      turn.record.query = message
      turn.record.messages.push({ role: 'user', content: message })

      const result = await fw.timed('chat', async (chat) => {
        const stream = streamText({
          model,
          prompt: message,
          tools: { lookup },
          stopWhen: stepCountIs(3),
          experimental_telemetry: fw.aiSdkTelemetry({ functionId: AGENT }),
        })
        // Practice 2: mark the first chunk, the tool input window and the last token.
        const toolNames = new Map<string, string>()
        for await (const part of stream.fullStream) recordStreamPart(chat, part, toolNames)
        return stream
      })

      const steps = await result.steps
      fw.recordUsage(fw.timeline(), await result.totalUsage, tl.toJSON().marks)

      // The record keeps the whole conversation of the turn, tool results included.
      const messages: TurnMessage[] = []
      for (const step of steps) {
        const toolCalls = step.toolCalls.map(c => ({ toolName: c.toolName, input: c.input as Record<string, unknown>, toolCallId: c.toolCallId }))
        messages.push({ role: 'assistant', content: step.text, ...(toolCalls.length > 0 ? { toolCalls } : {}) })
        for (const r of step.toolResults) {
          messages.push({ role: 'tool', content: JSON.stringify(r.output), toolName: r.toolName, toolCallId: r.toolCallId })
        }
      }
      turn.record.messages.push(...messages)
      turn.record.answer = await result.text
      turn.record.guardrails.push({ name: 'used_lookup', passed: messages.some(m => m.role === 'tool') })

      // Practice 3: the model handle writes app.model.answer.* on the turn span.
      fw.model('answer', ANSWER_SCHEMA).set({ finish_reason: await result.finishReason, step_count: steps.length })

      // Practice 6: return the turn ref, so the client can send feedback on this turn.
      res.json({ answer: turn.record.answer, turn: turn.ref })

      // Practice 2: close the request after the last write, and put the
      // timeline on the turn span as app.timeline.* attributes.
      tl.endRequest()
      fw.set(fw.timelineAttributes(tl.toJSON()))
    })
  })

  app.post('/feedback', (req, res) => {
    const { turn, rating, comment, conversationId } = req.body ?? {}
    if (!isTurnRef(turn) || (rating !== 'up' && rating !== 'down')) {
      res.status(400).json({ error: 'expected { turn: { traceId, spanId }, rating: "up" | "down" }' })
      return
    }
    // Practice 6: the feedback span joins the turn's trace, as a child of the turn span.
    flywheel().feedback({
      kind: 'rating',
      name: 'user_feedback',
      turn,
      rating,
      ...(typeof comment === 'string' ? { comment } : {}),
      ...(typeof conversationId === 'string' ? { session: conversationId } : {}),
    })
    res.status(204).end()
  })

  return app
}

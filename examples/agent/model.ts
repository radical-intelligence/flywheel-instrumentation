/**
 * The language model of the example agent.
 *
 * By default it is a mock model, so the example runs with no API key and no
 * network. The mock calls the `lookup` tool on its first step, and answers
 * with the tool result on its second step. Set `EXAMPLE_OPENAI_MODEL` (and
 * `OPENAI_API_KEY`) to use an OpenAI model in its place.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { simulateReadableStream } from 'ai'
import type { LanguageModel } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'

type MockStream = Awaited<ReturnType<MockLanguageModelV2['doStream']>>
type StreamPart = MockStream['stream'] extends ReadableStream<infer P> ? P : never
type Prompt = Parameters<MockLanguageModelV2['doStream']>[0]['prompt']

function stream(chunks: StreamPart[]): MockStream {
  return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 5 }) }
}

/** The text of the last user message. */
function lastUserText(prompt: Prompt): string {
  const user = prompt.filter(m => m.role === 'user').at(-1)
  if (!user) return ''
  return user.content.map(p => (p.type === 'text' ? p.text : '')).join(' ').trim()
}

/** The output of the last tool result, as JSON. */
function lastToolOutput(prompt: Prompt): string | undefined {
  const part = prompt.flatMap(m => (m.role === 'tool' ? m.content : [])).at(-1)
  return part ? JSON.stringify(part.output.value) : undefined
}

function mockModel(): LanguageModel {
  return new MockLanguageModelV2({
    modelId: 'mock-model',
    doStream: async ({ prompt }) => {
      const output = lastToolOutput(prompt)
      if (output === undefined) {
        const input = JSON.stringify({ topic: lastUserText(prompt) })
        return stream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call-1', toolName: 'lookup' },
          { type: 'tool-input-delta', id: 'call-1', delta: input },
          { type: 'tool-input-end', id: 'call-1' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input },
          { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 } },
        ])
      }
      return stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'The lookup found: ' },
        { type: 'text-delta', id: 'text-1', delta: output },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 70, outputTokens: 20, totalTokens: 90 } },
      ])
    },
  })
}

export function createModel(): { model: LanguageModel; modelName: string } {
  const openaiModel = process.env.EXAMPLE_OPENAI_MODEL
  if (openaiModel) return { model: createOpenAI()(openaiModel), modelName: openaiModel }
  return { model: mockModel(), modelName: 'mock-model' }
}

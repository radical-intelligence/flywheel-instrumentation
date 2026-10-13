/**
 * The attribute names of the turn record (`src/turn.ts`).
 *
 * This module imports types only, so `src/manifest.ts` can register the names
 * when the package loads with no import cycle through `src/turn.ts`.
 */
import type { AttributeSpec } from './types.js'

/**
 * How the turn ended.
 *
 * - `answered`: the product gave an answer. The default when `fn` resolves.
 * - `refused`: the product declined to answer, for example out of scope.
 * - `error`: `fn` threw.
 * - `aborted`: the turn stopped before it finished, for example the client
 *   disconnected. Set when `fn` throws an error named `AbortError`.
 */
export const TURN_OUTCOMES = ['answered', 'refused', 'error', 'aborted'] as const
export type TurnOutcome = typeof TURN_OUTCOMES[number]

const STRING: AttributeSpec = { type: 'string' }
const CUT: AttributeSpec = { type: 'boolean' }

/**
 * Every attribute name that a turn can write, for the manifest. `<name>` and
 * `<step>` stand for the guardrail names and the timing keys of the caller.
 * The manifest registers it under the source `turn` when the package loads.
 */
export const TURN_ATTRIBUTES: Record<string, AttributeSpec> = {
  'gen_ai.operation.name': { type: 'enum', values: ['invoke_agent'] },
  'gen_ai.agent.name': STRING,
  'gen_ai.conversation.id': STRING,
  'gen_ai.request.model': STRING,
  'gen_ai.request.model.truncated': CUT,
  'gen_ai.usage.input_tokens': { type: 'count' },
  'gen_ai.usage.output_tokens': { type: 'count' },
  'app.turn.outcome': { type: 'enum', values: TURN_OUTCOMES },
  'app.turn.query': STRING,
  'app.turn.query.truncated': CUT,
  'app.turn.answer': STRING,
  'app.turn.answer.truncated': CUT,
  'app.turn.messages': STRING,
  'app.turn.messages.truncated': CUT,
  'app.turn.message_count': { type: 'count' },
  'app.turn.tool_called': { type: 'boolean' },
  'app.turn.ms': { type: 'number' },
  'app.turn.guardrail.<name>.passed': { type: 'boolean' },
  'app.turn.guardrail.<name>.reason': STRING,
  'app.turn.guardrail.<name>.reason.truncated': CUT,
  'app.turn.timing.<step>': { type: 'number' },
}

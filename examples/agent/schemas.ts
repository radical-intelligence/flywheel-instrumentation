/**
 * The node schemas of the example agent (practices 3 and 5).
 *
 * Keep every schema in one module, and export the object as `schemas`. The
 * server passes it to `init({ schemas })`, and the manifest command imports
 * this module to list the attribute names:
 *
 *   npm run example:manifest
 */
import type { NodeSchemas } from '@radical-intelligence/flywheel-instrumentation'

/** The `lookup` tool: a state, a count in place of the results, and the topic it searched. */
export const LOOKUP_SCHEMA = {
  attributes: {
    status: { type: 'enum', values: ['ok', 'empty'] },
    result_count: { type: 'count' },
    topic: { type: 'string', maxLength: 64 },
  },
} as const

/** The model call of one turn: how the last step ended, and the number of steps. */
export const ANSWER_SCHEMA = {
  attributes: {
    finish_reason: { type: 'enum', values: ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'] },
    step_count: { type: 'count' },
  },
} as const

export const schemas = {
  tool: { lookup: LOOKUP_SCHEMA },
  model: { answer: ANSWER_SCHEMA },
} satisfies NodeSchemas

/** A product schema module, as the manifest CLI imports it. */
import { registerAttributes } from '../../src/manifest.js'
import type { NodeSchemas } from '../../src/index.js'

registerAttributes('fixture.turn', { 'app.turn.status': { type: 'enum', values: ['ok', 'error'] } })

export const schemas: NodeSchemas = {
  tool: { search: { attributes: { result_count: { type: 'count' } } } },
}

import { schemaMaxLength } from './schema.js'
import { PACKAGE_NAME, VERSION } from './version.js'
import type { AttributeSpec, InstrumentationManifest, ManifestAttribute, NodeSchemas, NodeType } from './types.js'

/** The attributes the instance writes itself, with no schema. */
const CORE: Record<string, AttributeSpec> = {
  'enduser.id': { type: 'string' },
  'session.id': { type: 'string' },
  'flywheel.attribute_error': { type: 'string[]' },
}

// Attributes that other modules write on the turn span, by source.
const registered = new Map<string, Record<string, AttributeSpec>>()

/**
 * Adds attributes that a module writes on the turn span to every manifest.
 * Each key is a full attribute name. A second call with the same source replaces the first.
 */
export function registerAttributes(source: string, attributes: Record<string, AttributeSpec>): void {
  registered.set(source, attributes)
}

function entry(name: string, spec: AttributeSpec, source: string, maxLength?: number): ManifestAttribute {
  const out: ManifestAttribute = { name, type: spec.type, source }
  if (spec.type === 'enum') out.values = [...spec.values]
  if (spec.type === 'string' || spec.type === 'string[]') {
    const limit = spec.maxLength ?? maxLength
    if (limit !== undefined) out.maxLength = limit
  }
  return out
}

/** The names that one node key can write, in the order the handle writes them. */
function nodeEntries(type: NodeType, name: string, key: string, spec: AttributeSpec, maxLength: number): ManifestAttribute[] {
  const source = `${type}.${name}`
  const prefix = `app.${type}.${name}.`
  const canonical = entry(`${prefix}${key}`, spec, source, maxLength)
  const cuts = spec.type === 'string' || spec.type === 'string[]'
  const out = [canonical]
  if (cuts) out.push({ name: `${canonical.name}.truncated`, type: 'boolean', source })
  if (spec.renamedFrom) {
    const { from, until } = spec.renamedFrom
    const old = { ...entry(`${prefix}${from}`, spec, source, maxLength), aliasOf: canonical.name, until }
    out.push(old)
    if (cuts) out.push({ name: `${old.name}.truncated`, type: 'boolean', source, aliasOf: `${canonical.name}.truncated`, until })
  }
  return out
}

/**
 * Lists every attribute name that the schemas, the core and the registered
 * modules can write, sorted by name. When two sources write one name, the
 * first keeps it.
 */
export function buildManifest(schemas: NodeSchemas = {}): InstrumentationManifest {
  const all: ManifestAttribute[] = []
  for (const [name, spec] of Object.entries(CORE)) all.push(entry(name, spec, 'core'))
  for (const type of ['tool', 'model', 'agent'] as const) {
    for (const [name, schema] of Object.entries(schemas[type] ?? {})) {
      const maxLength = schemaMaxLength(schema)
      for (const [key, spec] of Object.entries(schema.attributes)) all.push(...nodeEntries(type, name, key, spec, maxLength))
    }
  }
  for (const [source, attributes] of registered) {
    for (const [name, spec] of Object.entries(attributes)) all.push(entry(name, spec, source))
  }

  const seen = new Set<string>()
  const attributes = all.filter(a => !seen.has(a.name) && seen.add(a.name))
  attributes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { manifestVersion: 1, package: { name: PACKAGE_NAME, version: VERSION }, attributes }
}

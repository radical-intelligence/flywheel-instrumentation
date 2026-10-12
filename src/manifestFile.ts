import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildManifest } from './manifest.js'
import type { InstrumentationManifest, NodeSchemas } from './types.js'

/**
 * Imports a product's schema module and writes its manifest as JSON. The
 * module exports its node schemas as `schemas`, else as the default export.
 * Importing the module also runs any `registerAttributes()` call in it.
 */
export async function writeManifestFile(modulePath: string, outPath: string): Promise<InstrumentationManifest> {
  const mod = await import(pathToFileURL(resolve(modulePath)).href) as { schemas?: NodeSchemas; default?: NodeSchemas }
  const schemas = mod.schemas ?? mod.default
  if (schemas === undefined || typeof schemas !== 'object') {
    throw new Error(`${modulePath} exports no schemas: export them as \`schemas\` or as the default export`)
  }
  const manifest = buildManifest(schemas)
  writeFileSync(resolve(outPath), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

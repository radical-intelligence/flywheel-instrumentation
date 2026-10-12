#!/usr/bin/env node
/**
 * Writes instrumentation-manifest.json from a product's schema module.
 *
 *   flywheel-instrumentation-manifest <schema-module> [--out <file>]
 *
 * A TypeScript module needs a loader, for example `node --import tsx`.
 */
import { writeManifestFile } from './manifestFile.js'

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const out = outFlag === -1 ? 'instrumentation-manifest.json' : args[outFlag + 1]
const modulePath = args.find((a, i) => !a.startsWith('--') && (outFlag === -1 || i !== outFlag + 1))

if (!modulePath || !out) {
  console.error('usage: flywheel-instrumentation-manifest <schema-module> [--out <file>]')
  process.exit(2)
}

try {
  const manifest = await writeManifestFile(modulePath, out)
  console.log(`wrote ${manifest.attributes.length} attributes to ${out}`)
} catch (error) {
  console.error(`flywheel-instrumentation-manifest: ${(error as Error).message}`)
  process.exit(1)
}

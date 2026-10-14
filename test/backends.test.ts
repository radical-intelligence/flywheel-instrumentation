/**
 * Checks that each backend example stops before it serves when its
 * environment variables are missing. The child process has no backend
 * variables, so it makes no network call. `npm run typecheck` checks that
 * each backend `telemetry.ts` compiles.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

/** Runs a backend entry with every backend variable removed. */
function runEntry(entry: string): { status: number | null; stderr: string } {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('APPLICATIONINSIGHTS_') && !k.startsWith('LANGFUSE_')),
  )
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], { env: { ...env, PORT: '0' }, encoding: 'utf8', timeout: 30_000 })
  return { status: result.status, stderr: result.stderr }
}

test('the Azure Monitor example exits with 1 and names the missing connection string', () => {
  const { status, stderr } = runEntry('examples/azure-appi/main.ts')
  assert.equal(status, 1)
  assert.match(stderr, /Azure Monitor needs APPLICATIONINSIGHTS_CONNECTION_STRING in the environment/)
})

test('the Langfuse example exits with 1 and names the missing keys', () => {
  const { status, stderr } = runEntry('examples/langfuse/main.ts')
  assert.equal(status, 1)
  assert.match(stderr, /Langfuse needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY in the environment/)
})

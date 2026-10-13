/**
 * Runs the contract suite under node:test. Each case in contract.ts becomes
 * one top-level test. Top-level tests in one file run in order, and the
 * first case needs that order (see the contract.ts header).
 *
 * Many cases call `init()` with no SDK, so the self-check writes
 * `no_tracer_provider` with console.error. The runner drops that line only.
 * A case that reads the console replaces console.error itself, so it still
 * sees the line.
 */
import { test } from 'node:test'
import { contractCases } from './contract.js'

const NO_TRACER_PROVIDER = /^flywheel self-check: no_tracer_provider: /

async function quiet(run: () => Promise<void>): Promise<void> {
  const { error } = console
  console.error = (...args: unknown[]) => {
    if (!NO_TRACER_PROVIDER.test(args.join(' '))) error(...args)
  }
  try {
    await run()
  } finally {
    console.error = error
  }
}

for (const c of contractCases) test(c.name, () => quiet(c.run))

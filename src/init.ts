import { noopInstance } from './noop.js'
import { createInstance } from './instance.js'
import { claimStartupSpan, printIssues, runSelfCheck, selfCheckSettings } from './selfCheck.js'
import type { FlywheelInstance, InitOptions } from './types.js'

let current: FlywheelInstance = noopInstance

/**
 * Creates the live instance and runs its self-check. The first init() that
 * finds a tracer provider also emits the `flywheel.startup` span. A failed
 * check writes to the console and does not stop the product, except in
 * strict mode, where it throws and keeps the previous instance.
 */
export function init(options?: InitOptions): FlywheelInstance {
  const instance = createInstance(options)
  const report = runSelfCheck(instance.manifest(), selfCheckSettings(options), claimStartupSpan())
  printIssues(report)
  if (!report.ok && options?.strict) {
    const errors = report.issues.filter(i => i.level === 'error').map(i => i.code)
    throw new Error(`flywheel: self-check failed: ${errors.join(', ')}`)
  }
  current = instance
  return current
}

export function flywheel(): FlywheelInstance {
  return current
}

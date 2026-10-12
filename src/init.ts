import { noopInstance } from './noop.js'
import { createInstance } from './instance.js'
import type { FlywheelInstance, InitOptions } from './types.js'

let current: FlywheelInstance = noopInstance

export function init(options?: InitOptions): FlywheelInstance {
  current = createInstance(options)
  return current
}

export function flywheel(): FlywheelInstance {
  return current
}

import { noopInstance } from './noop.js'
import { createInstance } from './instance.js'
import type { FlywheelInstance } from './types.js'

let current: FlywheelInstance = noopInstance

export function init(): FlywheelInstance {
  current = createInstance()
  return current
}

export function flywheel(): FlywheelInstance {
  return current
}

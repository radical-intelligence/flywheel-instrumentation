/**
 * The example agent with Azure Monitor as the backend: `npm run example:azure`.
 *
 * It reuses `start()` from `examples/agent/main.ts`. Only the telemetry
 * registration and the `init()` options change. It stops with exit code 1
 * when `APPLICATIONINSIGHTS_CONNECTION_STRING` is not set.
 */
import { isEntry, run } from '../agent/main.js'
import { AZURE_INIT, registerAzureMonitor } from './telemetry.js'

if (isEntry(import.meta.url)) await run('example agent (Azure Monitor)', { register: registerAzureMonitor, init: AZURE_INIT })

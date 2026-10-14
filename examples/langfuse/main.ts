/**
 * The example agent with Langfuse as the backend: `npm run example:langfuse`.
 *
 * It reuses `start()` from `examples/agent/main.ts`. Only the telemetry
 * registration changes. The default `init()` options apply, because
 * Langfuse ingests no log records. It stops with exit code 1 when
 * `LANGFUSE_PUBLIC_KEY` or `LANGFUSE_SECRET_KEY` is not set.
 */
import { isEntry, run } from '../agent/main.js'
import { registerLangfuse } from './telemetry.js'

if (isEntry(import.meta.url)) await run('example agent (Langfuse)', { register: registerLangfuse })

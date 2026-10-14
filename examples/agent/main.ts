/**
 * The entry point of the example agent: `npm run example`.
 *
 * The order is the order a product follows. Register the OpenTelemetry
 * providers, call `init({ schemas })`, check the telemetry, then serve.
 *
 * `start()` takes the backend as an option, so each backend example
 * (`examples/azure-appi/`, `examples/langfuse/`) reuses this file and
 * changes only the telemetry registration and the `init()` options.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { init } from '@radical-intelligence/flywheel-instrumentation'
import type { InitOptions, SelfCheckReport } from '@radical-intelligence/flywheel-instrumentation'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import { createApp } from './app.js'
import { schemas } from './schemas.js'
import { registerTelemetry } from './telemetry.js'
import type { Telemetry } from './telemetry.js'

export interface StartOptions {
  port?: number
  /** Registers the providers for a backend. The default writes to the console. */
  register?: () => Telemetry
  /** The `init()` options for the backend. `start()` adds the schemas. */
  init?: Omit<InitOptions, 'schemas'>
  /** The exporters of the default registration. The test passes in-memory exporters. */
  spanExporter?: SpanExporter
  logExporter?: LogRecordExporter
}

export interface Started {
  server: Server
  url: string
  report: SelfCheckReport
  telemetry: Telemetry
}

export async function start(options: StartOptions = {}): Promise<Started> {
  const telemetry = options.register ? options.register() : registerTelemetry(options.spanExporter, options.logExporter)

  // init() runs the self-check, prints each issue and emits the
  // flywheel.startup span. selfCheck() returns the report, so the server can
  // refuse to start on a failed check (practice 4). It emits a second
  // flywheel.startup span.
  const fw = init({ ...options.init, schemas })
  const report = fw.selfCheck()
  await telemetry.flush()
  if (!report.ok) {
    await telemetry.shutdown()
    throw new Error(`telemetry self-check failed: ${report.issues.map(i => i.code).join(', ')}`)
  }

  const server = createApp().listen(options.port ?? 0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://localhost:${port}`, report, telemetry }
}

/**
 * Starts the agent on `PORT` (default 3000) and exports the pending
 * telemetry on SIGINT. A failed start prints its reason and exits with 1.
 */
export async function run(name: string, options: StartOptions = {}): Promise<void> {
  let started: Started
  try {
    started = await start({ ...options, port: Number(process.env.PORT ?? 3000) })
  } catch (error) {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const { server, url, telemetry } = started
  console.log(`${name} listening on ${url}`)
  process.once('SIGINT', () => {
    server.close()
    void telemetry.shutdown()
  })
}

/** True when `moduleUrl` is the module that `node` was started with. */
export function isEntry(moduleUrl: string): boolean {
  return moduleUrl === pathToFileURL(process.argv[1] ?? '').href
}

if (isEntry(import.meta.url)) await run('example agent')

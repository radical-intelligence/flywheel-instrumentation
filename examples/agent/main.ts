/**
 * The entry point of the example agent: `npm run example`.
 *
 * The order is the order a product follows. Register the OpenTelemetry
 * providers, call `init({ schemas })`, check the telemetry, then serve.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { init } from '@radical-intelligence/flywheel-instrumentation'
import type { SelfCheckReport } from '@radical-intelligence/flywheel-instrumentation'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import { createApp } from './app.js'
import { schemas } from './schemas.js'
import { registerTelemetry } from './telemetry.js'
import type { Telemetry } from './telemetry.js'

export interface StartOptions {
  port?: number
  /** The exporters. The default writes to the console. */
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
  const telemetry = registerTelemetry(options.spanExporter, options.logExporter)

  // init() runs the self-check, prints each issue and emits the
  // flywheel.startup span. selfCheck() returns the report, so the server can
  // refuse to start on a failed check (practice 4). It emits a second
  // flywheel.startup span.
  const fw = init({ schemas })
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { server, url, telemetry } = await start({ port: Number(process.env.PORT ?? 3000) })
  console.log(`example agent listening on ${url}`)
  process.once('SIGINT', () => {
    server.close()
    void telemetry.shutdown()
  })
}

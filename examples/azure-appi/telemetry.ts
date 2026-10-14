/**
 * The OpenTelemetry registration for Azure Monitor (Application Insights).
 * This is the only file that differs from the console example in
 * `examples/agent/telemetry.ts`. `examples/azure-appi/AGENTS.md` says where
 * each practice lands in Application Insights.
 *
 * `useAzureMonitor()` registers the tracer provider, the logger provider and
 * the context manager. It reads the span attribute limit from
 * `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`.
 */
import { trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { shutdownAzureMonitor, useAzureMonitor } from '@azure/monitor-opentelemetry'
import { requireEnv } from '../agent/telemetry.js'
import type { Telemetry } from '../agent/telemetry.js'

export const AZURE_ENV = ['APPLICATIONINSIGHTS_CONNECTION_STRING'] as const

interface Flushable {
  forceFlush?(): Promise<void>
}

/** The registered provider behind the API proxy, or the provider itself. */
function delegate(provider: unknown): Flushable {
  const proxy = provider as { getDelegate?(): unknown }
  return (proxy.getDelegate ? proxy.getDelegate() : provider) as Flushable
}

export function registerAzureMonitor(): Telemetry {
  const [connectionString] = requireEnv('Azure Monitor', AZURE_ENV)
  // The SDK default of 128 attributes drops keys from a full turn span with no error.
  process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT ??= '1024'
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    // The default sampler limits traces per second, from a rate of zero at
    // start-up. It drops the flywheel.startup span, so the self-check
    // cannot prove that telemetry arrives (practice 4). Sample every trace.
    tracesPerSecond: 0,
    samplingRatio: 1,
  })

  return {
    async flush() {
      await delegate(trace.getTracerProvider()).forceFlush?.()
      await delegate(logs.getLoggerProvider()).forceFlush?.()
    },
    shutdown: shutdownAzureMonitor,
  }
}

/** `init()` options for Azure Monitor: feedback also goes to `customEvents`. */
export const AZURE_INIT = { azureCustomEvents: true }

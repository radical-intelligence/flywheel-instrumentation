/**
 * The OpenTelemetry SDK of the example agent. The product registers the
 * providers and the exporters, before it calls `init()`. The package uses
 * the OpenTelemetry API only.
 *
 * The example writes spans and log records to the console. The test passes
 * in-memory exporters in their place. For a real backend, change the
 * exporters here (see "Backends" in AGENTS.md):
 *
 * - Azure Monitor: call `useAzureMonitor()` from `@azure/monitor-opentelemetry`
 *   in place of this function. It registers both providers.
 * - Langfuse: add `LangfuseSpanProcessor` from `@langfuse/otel` to
 *   `spanProcessors`. Langfuse does not ingest log records.
 */
import { context, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ConsoleLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'

export interface Telemetry {
  /** Export every pending span and log record. */
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export function registerTelemetry(
  spanExporter: SpanExporter = new ConsoleSpanExporter(),
  logExporter: LogRecordExporter = new ConsoleLogRecordExporter(),
): Telemetry {
  // The context manager makes the turn span the parent of the spans inside it.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  // The SDK default of 128 attributes drops keys from a full turn span with no error.
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    spanLimits: { attributeCountLimit: 1024 },
  })
  const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] })
  trace.setGlobalTracerProvider(tracerProvider)
  logs.setGlobalLoggerProvider(loggerProvider)

  return {
    async flush() {
      await tracerProvider.forceFlush()
      await loggerProvider.forceFlush()
    },
    async shutdown() {
      await tracerProvider.shutdown()
      await loggerProvider.shutdown()
    },
  }
}

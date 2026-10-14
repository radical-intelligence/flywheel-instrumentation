/**
 * The OpenTelemetry SDK of the example agent. The product registers the
 * providers and the exporters, before it calls `init()`. The package uses
 * the OpenTelemetry API only.
 *
 * The example writes spans and log records to the console. The test passes
 * in-memory exporters in their place. A real backend changes this
 * registration only:
 *
 * - Azure Monitor: `examples/azure-appi/telemetry.ts`.
 * - Langfuse: `examples/langfuse/telemetry.ts`.
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

/**
 * Returns the value of each variable, in order. Throws one error that names
 * every missing variable, so a backend example stops before it registers
 * anything.
 */
export function requireEnv(backend: string, names: readonly string[]): string[] {
  const missing = names.filter(name => !process.env[name])
  if (missing.length > 0) throw new Error(`${backend} needs ${missing.join(', ')} in the environment`)
  return names.map(name => process.env[name] as string)
}

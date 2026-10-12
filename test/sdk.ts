/**
 * A real OpenTelemetry SDK for the contract suite: a tracer provider and a
 * logger provider, each with an in-memory exporter, registered as the global
 * providers for the length of one case.
 *
 * It uses no test framework, so any runner (Jest, node:test) can call it.
 */
import { context, trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'

export interface Sdk {
  /** Every span that has ended, in end order. */
  spans(): ReadableSpan[]
  /** Every log record emitted. */
  logRecords(): ReadableLogRecord[]
  /** Run `fn` with a new span as the active span, and end the span when `fn` settles. */
  inSpan<T>(name: string, fn: (span: Span) => T | Promise<T>): Promise<T>
  /** The ended span with this name. Throws when there is not exactly one. */
  span(name: string): ReadableSpan
}

/** Register a fresh SDK, run `fn`, then remove every global the SDK set. */
export async function withSdk(fn: (sdk: Sdk) => void | Promise<void>): Promise<void> {
  const spanExporter = new InMemorySpanExporter()
  const logExporter = new InMemoryLogRecordExporter()
  const contextManager = new AsyncLocalStorageContextManager().enable()
  // 1024 as apps/server/telemetry.mjs sets it. The SDK default of 128 drops keys.
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    spanLimits: { attributeCountLimit: 1024 },
  })
  const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] })

  context.setGlobalContextManager(contextManager)
  trace.setGlobalTracerProvider(tracerProvider)
  logs.setGlobalLoggerProvider(loggerProvider)

  const tracer = tracerProvider.getTracer('contract')
  const sdk: Sdk = {
    spans: () => spanExporter.getFinishedSpans(),
    logRecords: () => logExporter.getFinishedLogRecords(),
    async inSpan(name, fn) {
      const span = tracer.startSpan(name)
      try {
        return await context.with(trace.setSpan(context.active(), span), () => fn(span))
      } finally {
        span.end()
      }
    },
    span(name) {
      const found = spanExporter.getFinishedSpans().filter(s => s.name === name)
      if (found.length !== 1) throw new Error(`expected one ended span named ${name}, found ${found.length}`)
      return found[0]
    },
  }

  try {
    await fn(sdk)
  } finally {
    await tracerProvider.shutdown()
    await loggerProvider.shutdown()
    trace.disable()
    logs.disable()
    context.disable()
  }
}

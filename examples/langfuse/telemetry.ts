/**
 * The OpenTelemetry registration for Langfuse. This is the only file that
 * differs from the console example in `examples/agent/telemetry.ts`.
 * `examples/langfuse/AGENTS.md` says where each practice lands in Langfuse.
 *
 * Langfuse ingests spans only, so there is no logger provider. The
 * processor reads `LANGFUSE_BASE_URL` (default: Langfuse Cloud) itself.
 */
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { requireEnv } from '../agent/telemetry.js'
import type { Telemetry } from '../agent/telemetry.js'

export const LANGFUSE_ENV = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'] as const

export function registerLangfuse(): Telemetry {
  const [publicKey, secretKey] = requireEnv('Langfuse', LANGFUSE_ENV)
  // The context manager makes the turn span the parent of the spans inside it.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        // The default filter drops each span with no gen_ai.* attribute that
        // no known LLM library wrote. That drops flywheel.startup and the
        // feedback spans, so export every span.
        shouldExportSpan: () => true,
      }),
    ],
    // The SDK default of 128 attributes drops keys from a full turn span with no error.
    spanLimits: { attributeCountLimit: 1024 },
  })
  trace.setGlobalTracerProvider(tracerProvider)

  return {
    flush: () => tracerProvider.forceFlush(),
    shutdown: () => tracerProvider.shutdown(),
  }
}

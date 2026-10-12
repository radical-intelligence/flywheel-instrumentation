import { trace } from '@opentelemetry/api'
import type { AttributeValue } from '@opentelemetry/api'
import { createNodeHandle } from './node.js'
import { emitMetadata } from './metadata.js'
import type { FlywheelInstance, NodeHandle, AiSdkTelemetryConfig, AiSdkTelemetryOptions } from './types.js'

export function createInstance(): FlywheelInstance {
  return {
    tool(name: string): NodeHandle {
      return createNodeHandle('tool', name)
    },

    model(name: string): NodeHandle {
      return createNodeHandle('model', name)
    },

    agent(name: string): NodeHandle {
      return createNodeHandle('agent', name)
    },

    set(attrs: Record<string, AttributeValue>) {
      const span = trace.getActiveSpan()
      if (!span) return
      for (const [key, value] of Object.entries(attrs)) {
        span.setAttribute(key, value)
      }
    },

    metadata(traceId: string, eventName: string, attrs: Record<string, AttributeValue>) {
      emitMetadata(traceId, eventName, attrs)
    },

    getTraceId(): string | undefined {
      return trace.getActiveSpan()?.spanContext()?.traceId
    },

    aiSdkTelemetry(options?: AiSdkTelemetryOptions): AiSdkTelemetryConfig {
      return {
        isEnabled: true,
        functionId: options?.functionId ?? 'unknown',
        recordInputs: true,
        recordOutputs: true,
        metadata: options?.metadata ?? {},
      }
    },

    async flush() {
      // OTEL flush is handled by the provider registered in telemetry.mjs.
      // This method exists so callers can await without knowing whether OTEL
      // is live or noop.
    },
  }
}

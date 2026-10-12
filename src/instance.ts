import { trace } from '@opentelemetry/api'
import type { AttributeValue } from '@opentelemetry/api'
import { createNodeHandle, createSchemaNodeHandle } from './node.js'
import { emitMetadata } from './metadata.js'
import { clockMethods } from './timeline.js'
import { runTurn } from './turn.js'
import type { Turn, TurnOptions } from './turn.js'
import { activeTurnRef, emitFeedback } from './feedback.js'
import { reportInvalid, writeSettings } from './schema.js'
import { buildManifest } from './manifest.js'
import { runSelfCheck, selfCheckSettings } from './selfCheck.js'
import type {
  FlywheelInstance, NodeHandle, NodeSchema, NodeType, InitOptions, AiSdkTelemetryConfig, AiSdkTelemetryOptions, FeedbackEvent,
} from './types.js'

export function createInstance(options?: InitOptions): FlywheelInstance {
  const settings = writeSettings(options)
  const customEvents = options?.azureCustomEvents ?? false
  const schemas = options?.schemas ?? {}
  const checkSettings = selfCheckSettings(options)

  // The overloads in types.ts give a schema handle its typed keys.
  const handle = (type: NodeType, name: string, schema?: NodeSchema): NodeHandle<any> =>
    schema ? createSchemaNodeHandle(type, name, schema, settings) : createNodeHandle(type, name)

  const setId = (attribute: string, id: unknown) => {
    const span = trace.getActiveSpan()
    if (!span) return
    if (typeof id !== 'string' || id.length === 0) {
      reportInvalid(span, settings, attribute, 'expected a non-empty string')
      return
    }
    span.setAttribute(attribute, id)
  }

  return {
    tool(name: string, schema?: NodeSchema) {
      return handle('tool', name, schema)
    },

    model(name: string, schema?: NodeSchema) {
      return handle('model', name, schema)
    },

    agent(name: string, schema?: NodeSchema) {
      return handle('agent', name, schema)
    },

    set(attrs: Record<string, AttributeValue>) {
      const span = trace.getActiveSpan()
      if (!span) return
      for (const [key, value] of Object.entries(attrs)) {
        span.setAttribute(key, value)
      }
    },

    user(id: string) {
      setId('enduser.id', id)
    },

    session(id: string) {
      setId('session.id', id)
    },

    metadata(traceId: string, eventName: string, attrs: Record<string, AttributeValue>) {
      emitMetadata(traceId, eventName, attrs)
    },

    getTraceId(): string | undefined {
      return trace.getActiveSpan()?.spanContext()?.traceId
    },

    turnRef() {
      return activeTurnRef()
    },

    feedback(event: FeedbackEvent) {
      emitFeedback(event, customEvents)
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

    selfCheck() {
      return runSelfCheck(buildManifest(schemas), checkSettings, true)
    },

    manifest() {
      return buildManifest(schemas)
    },

    turn<T>(options: TurnOptions, fn: (turn: Turn) => T | Promise<T>): Promise<T> {
      return runTurn(settings, options, fn)
    },

    ...clockMethods,
  }
}

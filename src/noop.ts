import { clockMethods } from './timeline.js'
import { buildManifest } from './manifest.js'
import { DEFAULT_ATTRIBUTE_COUNT_LIMIT, DEFAULT_VALUE_SIZE_LIMIT } from './selfCheck.js'
import type { FlywheelInstance, NodeHandle, AiSdkTelemetryConfig, AiSdkTelemetryOptions, SelfCheckReport } from './types.js'
import { runNoopTurn } from './turn.js'

const noopHandle: NodeHandle<any> = {
  set() {},
}

export const noopInstance: FlywheelInstance = {
  tool() { return noopHandle },
  model() { return noopHandle },
  agent() { return noopHandle },
  set() {},
  user() {},
  session() {},
  metadata() {},
  getTraceId() { return undefined },
  turnRef() { return undefined },
  feedback() {},
  aiSdkTelemetry(options?: AiSdkTelemetryOptions): AiSdkTelemetryConfig {
    return {
      isEnabled: false,
      functionId: options?.functionId ?? 'unknown',
      recordInputs: false,
      recordOutputs: false,
      metadata: options?.metadata ?? {},
    }
  },
  async flush() {},
  // The noop instance writes nothing, so its check fails and emits no span.
  selfCheck(): SelfCheckReport {
    return {
      ok: false,
      tracerProvider: false,
      loggerProvider: undefined,
      startupSpan: undefined,
      attributeCountLimit: { value: DEFAULT_ATTRIBUTE_COUNT_LIMIT, source: 'default' },
      valueSizeLimit: DEFAULT_VALUE_SIZE_LIMIT,
      attributeCounts: { turn: 0, nodes: {} },
      issues: [{ level: 'error', code: 'not_initialised', message: 'init() has not run, so the noop instance writes nothing' }],
    }
  },
  manifest() {
    return { ...buildManifest(), attributes: [] }
  },
  turn: runNoopTurn,
  // The clock writes no telemetry, so the noop instance keeps it.
  ...clockMethods,
}

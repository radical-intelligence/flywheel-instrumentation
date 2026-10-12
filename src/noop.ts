import type { FlywheelInstance, NodeHandle, AiSdkTelemetryConfig, AiSdkTelemetryOptions } from './types.js'

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
}

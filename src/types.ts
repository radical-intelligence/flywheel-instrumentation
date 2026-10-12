import type { AttributeValue } from '@opentelemetry/api'

export type NodeType = 'tool' | 'model' | 'agent'

export interface NodeHandle {
  set(attrs: Record<string, AttributeValue>): void
}

export interface FlywheelInstance {
  tool(name: string): NodeHandle
  model(name: string): NodeHandle
  agent(name: string): NodeHandle
  set(attrs: Record<string, AttributeValue>): void
  metadata(traceId: string, eventName: string, attrs: Record<string, AttributeValue>): void
  getTraceId(): string | undefined
  aiSdkTelemetry(options?: AiSdkTelemetryOptions): AiSdkTelemetryConfig
  flush(): Promise<void>
}

export interface AiSdkTelemetryOptions {
  functionId?: string
  metadata?: Record<string, string>
}

export interface AiSdkTelemetryConfig {
  isEnabled: boolean
  functionId: string
  recordInputs: boolean
  recordOutputs: boolean
  metadata: Record<string, string>
}

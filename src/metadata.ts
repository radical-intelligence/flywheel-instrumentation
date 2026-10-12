import { trace, ROOT_CONTEXT, TraceFlags } from '@opentelemetry/api'
import type { AttributeValue } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'

const LOGGER_NAME = 'flywheel'

export function emitMetadata(
  traceId: string,
  eventName: string,
  attrs: Record<string, AttributeValue>
): void {
  const spanCtx = {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: TraceFlags.SAMPLED,
  }
  const context = trace.setSpanContext(ROOT_CONTEXT, spanCtx)

  const logger = logs.getLogger(LOGGER_NAME)
  logger.emit({
    context,
    severityNumber: SeverityNumber.INFO,
    attributes: {
      'microsoft.custom_event.name': eventName,
      ...attrs,
    },
  })
}

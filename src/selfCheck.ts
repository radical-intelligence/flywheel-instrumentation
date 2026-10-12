import { trace, ProxyTracerProvider, ROOT_CONTEXT, SpanKind, TraceFlags } from '@opentelemetry/api'
import type { Tracer } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { VERSION } from './version.js'
import type { InitOptions, InstrumentationManifest, SelfCheckIssue, SelfCheckReport } from './types.js'

export const STARTUP_SPAN = 'flywheel.startup'

/** The OpenTelemetry SDK default for the span attribute count limit. */
export const DEFAULT_ATTRIBUTE_COUNT_LIMIT = 128

/**
 * The default exporter value size limit, in bytes. Azure Monitor cuts a
 * custom dimension at 8192. Other exporters set other limits.
 */
export const DEFAULT_VALUE_SIZE_LIMIT = 8192

export interface SelfCheckSettings {
  requireLoggerProvider: boolean
  valueSizeLimit: number
}

export function selfCheckSettings(options?: InitOptions): SelfCheckSettings {
  return {
    requireLoggerProvider: options?.requireLoggerProvider ?? options?.azureCustomEvents ?? false,
    valueSizeLimit: options?.valueSizeLimit ?? DEFAULT_VALUE_SIZE_LIMIT,
  }
}

/**
 * The tracer that the registered provider gives, or undefined when no
 * provider is registered. The global provider is a proxy, and the proxy has
 * a delegate tracer only after a provider is registered.
 */
function registeredTracer(): Tracer | undefined {
  const provider = trace.getTracerProvider()
  if (provider instanceof ProxyTracerProvider) return provider.getDelegateTracer('flywheel', VERSION)
  return provider.getTracer('flywheel', VERSION)
}

/**
 * The span attribute count limit. The SDK tracer reports it with
 * `getSpanLimits()`, which includes the environment variable. With another
 * tracer, the check reads the environment variable, else the SDK default.
 */
function attributeCountLimit(tracer: Tracer | undefined): SelfCheckReport['attributeCountLimit'] {
  const fromSdk = (tracer as { getSpanLimits?: () => { attributeCountLimit?: unknown } } | undefined)
    ?.getSpanLimits?.()?.attributeCountLimit
  if (typeof fromSdk === 'number' && fromSdk > 0) return { value: fromSdk, source: 'sdk' }
  const fromEnv = Number.parseInt(globalThis.process?.env?.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return { value: fromEnv, source: 'env' }
  return { value: DEFAULT_ATTRIBUTE_COUNT_LIMIT, source: 'default' }
}

/** True when a logger provider is registered. Undefined with an api-logs version that has no `Logger.enabled()`. */
function loggerEnabled(): boolean | undefined {
  const logger = logs.getLogger('flywheel') as { enabled?: (options?: { severityNumber?: SeverityNumber }) => boolean }
  if (typeof logger.enabled !== 'function') return undefined
  return logger.enabled({ severityNumber: SeverityNumber.INFO })
}

// init() emits the start-up span once per process. selfCheck() emits one on each call.
let startupEmitted = false

/** True once, for the first init() in the process that finds a tracer provider. */
export function claimStartupSpan(): boolean {
  if (startupEmitted || registeredTracer() === undefined) return false
  startupEmitted = true
  return true
}

export function runSelfCheck(manifest: InstrumentationManifest, settings: SelfCheckSettings, emit: boolean): SelfCheckReport {
  const issues: SelfCheckIssue[] = []
  const add = (level: SelfCheckIssue['level'], code: SelfCheckIssue['code'], message: string) =>
    issues.push({ level, code, message })

  const nodes: Record<string, number> = {}
  for (const a of manifest.attributes) {
    if (/^(tool|model|agent)\./.test(a.source)) nodes[a.source] = (nodes[a.source] ?? 0) + 1
  }
  const turn = manifest.attributes.length

  const tracer = registeredTracer()
  const tracerProvider = tracer !== undefined
  const limit = attributeCountLimit(tracer)
  if (!tracerProvider) add('error', 'no_tracer_provider', 'no tracer provider is registered, so every span and attribute is dropped')

  const loggerProvider = loggerEnabled()
  if (settings.requireLoggerProvider) {
    if (loggerProvider === false) add('error', 'no_logger_provider', 'no logger provider is registered, so log records are dropped')
    if (loggerProvider === undefined) add('warning', 'logger_provider_unknown', 'this @opentelemetry/api-logs version cannot report a logger provider')
  }

  for (const [node, count] of Object.entries(nodes)) {
    if (count > limit.value) {
      add('warning', 'attribute_count_limit', `node ${node} declares ${count} attribute names, over the span attribute count limit of ${limit.value}`)
    }
  }
  if (turn > limit.value) {
    add('warning', 'attribute_count_limit', `one turn can write ${turn} attribute names, over the span attribute count limit of ${limit.value}`)
  }

  for (const a of manifest.attributes) {
    if (a.aliasOf === undefined && a.maxLength !== undefined && a.maxLength > settings.valueSizeLimit) {
      add('warning', 'value_size_limit', `${a.name} has maxLength ${a.maxLength}, over the exporter value size limit of ${settings.valueSizeLimit} bytes`)
    }
  }

  let startupSpan: SelfCheckReport['startupSpan']
  if (emit && tracer) {
    const span = tracer.startSpan(STARTUP_SPAN, { kind: SpanKind.INTERNAL }, ROOT_CONTEXT)
    const context = span.spanContext()
    const sampled = (context.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
    if (!sampled) add('warning', 'startup_span_not_sampled', `the sampler dropped the ${STARTUP_SPAN} span, so a query cannot find it`)
    span.setAttributes({
      'flywheel.version': VERSION,
      'flywheel.schema.node_count': Object.keys(nodes).length,
      'flywheel.schema.attribute_count': turn,
      'flywheel.attribute_count_limit': limit.value,
      'flywheel.self_check.ok': !issues.some(i => i.level === 'error'),
      'flywheel.self_check.issues': issues.map(i => i.code),
    })
    span.end()
    startupSpan = { traceId: context.traceId, sampled }
  }

  return {
    ok: !issues.some(i => i.level === 'error'),
    tracerProvider,
    loggerProvider,
    startupSpan,
    attributeCountLimit: limit,
    valueSizeLimit: settings.valueSizeLimit,
    attributeCounts: { turn, nodes },
    issues,
  }
}

/** Writes each issue to the console: an error with console.error, a warning with console.warn. */
export function printIssues(report: SelfCheckReport): void {
  for (const issue of report.issues) {
    const line = `flywheel self-check: ${issue.code}: ${issue.message}`
    if (issue.level === 'error') console.error(line)
    else console.warn(line)
  }
}

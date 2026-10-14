# AGENTS.md: the example agent on Azure Monitor

This file is for an AI agent that sends an instrumented agent's telemetry to Azure Monitor (Application Insights). It maps each of the seven practices to Application Insights: where the data lands and how to see it. FLS uses this backend today.

The agent is the shared blueprint in `examples/agent/` (see `examples/agent/AGENTS.md`). This folder holds only what Azure Monitor changes:

| File | Responsibility |
|---|---|
| `telemetry.ts` | Calls `useAzureMonitor()` from `@azure/monitor-opentelemetry`, which registers the tracer provider, the logger provider and the context manager. Sets the attribute limit and the sampler |
| `main.ts` | Calls `run()` from `examples/agent/main.ts` with the Azure Monitor registration and `init({ azureCustomEvents: true })` |

The attribute names are the same as on every other backend. Do not rename an attribute for Application Insights.

## Run it

| Variable | Required | Meaning |
|---|---|---|
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Yes | The connection string of the Application Insights resource |
| `OTEL_SERVICE_NAME` | No | The value of `cloud_RoleName`. The default is `unknown_service:node` |

Run `npm run build`, then `npm run example:azure`. Without the connection string, the example prints the missing name and exits with code 1. `test/backends.test.ts` checks this.

## Setup rules

- Raise the span attribute count limit to 1024. `telemetry.ts` sets `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`, which the SDK reads.
- Sample every trace, or confirm that the sampler keeps `flywheel.startup`. In `@azure/monitor-opentelemetry` 1.19.0, the default sampler limits traces per second, from a rate of zero at start-up. With it, the self-check warns `startup_span_not_sampled`. `telemetry.ts` sets `tracesPerSecond: 0` and `samplingRatio: 1`.
- Call `init({ azureCustomEvents: true })`, so feedback also reaches `customEvents`, where FLS's saved queries read it.

## Where each practice lands

Each row ran against an Application Insights resource on 2026-10-15, with one chat and one feedback, and was read back with KQL. A row marked unverified did not.

| Practice | Where it lands in Application Insights | How to see it |
|---|---|---|
| 1. One record per turn | The turn span is a `dependencies` row named `invoke_agent <agent>`, of type `Dependency`. Its `operation_ParentId` is its `operation_Id`, because it is the root. The AI SDK spans (`ai.streamText`, `ai.streamText.doStream`, `ai.toolCall`) are `dependencies` rows on the same `operation_Id`, each with its parent span ID in `operation_ParentId` | `dependencies \| where operation_Id == '<traceId>'` |
| 2. One clock per request | `app.timeline.*` and `app.turn.timing.*` are in the `customDimensions` of the turn row. `duration` is the turn span duration | The `customDimensions` of the turn row |
| 3. Consistent span attributes | Each span attribute is a `customDimensions` key with its full name, for example `app.tool.lookup.status` on the `ai.toolCall` row. `session.id` stays in `customDimensions`. The `session_Id` column is empty | `customDimensions['app.turn.outcome']` |
| 4. Check the logging works first | Each `flywheel.startup` span is a `dependencies` row in its own operation, with the `flywheel.*` attributes in `customDimensions` | The start-up query under practice 4 in the root `AGENTS.md` |
| 5. Each evaluator lists the data it needs | Not in Application Insights. The manifest is a file. The names in it are the `customDimensions` keys | `npm run example:manifest` |
| 6. Feedback is attached to the turn | The `feedback()` span is a `dependencies` row of type `InProc`, named by its event name. Its `operation_Id` is the turn's trace ID, and its `operation_ParentId` is the turn span ID. With `azureCustomEvents`, a `customEvents` row with the same name and the same `feedback.*` keys in `customDimensions` has the same `operation_Id`, and the feedback span ID as its `operation_ParentId` | `customEvents \| where name == 'user_feedback'`, joined to the turn on `operation_Id` |
| 7. Agents read the record and act | Not in this package. The Flywheel reads the rows through KQL | See the Flywheel repository |

## Gaps

- No `requests` row. The example has no HTTP server span, so the turn span is the root of the operation. The cause is unverified: the example loads Express before `useAzureMonitor()` runs, so the HTTP instrumentation may not patch it. FLS registers telemetry with `node --import`, before any product code, and its request spans go to `requests` (see "Backends" in the root `AGENTS.md`).
- `session.id` and `enduser.id`: `session.id` does not fill `session_Id`. The example does not call `user()`, so this run does not show `user_AuthenticatedId`. The root `AGENTS.md` says the exporter writes `enduser.id` to it.
- A `customDimensions` value is cut at about 8 KB. The self-check warns when a declared `maxLength` is over 8192 bytes.
- The exporter adds `microsoft.gen_ai.main_agent.name`, `microsoft.gen_ai.main_agent.conversation_id` and `_MS.ResourceAttributeId` to `customDimensions`. They are not in the manifest.

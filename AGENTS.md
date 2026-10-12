# AGENTS.md

This file is for an AI agent that adds this package to a product, or changes the package itself.

## The package

`@radical-intelligence/flywheel-instrumentation` writes a product's telemetry onto OpenTelemetry spans and log records. The Flywheel reads that telemetry to evaluate each turn and to propose changes. The package uses only `@opentelemetry/api` and `@opentelemetry/api-logs`. The product registers the SDK and the exporter, so the package does not depend on one telemetry backend.

Install it as a git dependency, at a tag:

```bash
npm i github:radical-intelligence/flywheel-instrumentation#v0.1.0
npm i @opentelemetry/api @opentelemetry/api-logs
```

The install runs the `prepare` script, which builds `dist/`. The two OpenTelemetry packages are peer dependencies. See `package.json` for the ranges.

To initialise it:

1. Register a tracer provider and a logger provider before any product code runs (for example, a module loaded with `node --import`). The backend sections below name the setup for each backend.
2. Call `init()` once, after the providers exist. It returns the live instance.
3. Everywhere else, call `flywheel()`. Before `init()`, it returns a noop instance that writes nothing.

The public API is in `src/index.ts`, and the types are in `src/types.ts`.

## Practices

The blueprint "Observability for agentic systems" has seven practices. Each rule below is independent of the backend. Each status names the PR in this repository that closes the gap. A conformance test is a case name in `test/contract.ts`.

### 1. One record per turn

Rule: each turn produces one record that holds its input, output, steps and timings. A reader can rebuild the turn from that record alone.

Provides: node handles (`tool(name)`, `model(name)`, `agent(name)`) and `set()` write to the active span. `getTraceId()` returns the trace that identifies the turn. `aiSdkTelemetry()` returns the AI SDK telemetry settings, so model calls join the same trace. There is no turn record type.

Tests:

- `tool(name).set writes app.tool.<name>.<key> and the legacy app.<name>.<key>`
- `model(name).set writes app.model.<name>.<key> and the legacy app.<key>, with ttft_ms renamed`
- `agent(name).set writes app.agent.<name>.<key> only, with no legacy key`
- `writes go to the active span only`
- `getTraceId() returns the trace ID of the active span`
- `aiSdkTelemetry() on the live instance turns AI SDK telemetry on, with inputs and outputs`

Status: Partial. PR 4 (turn record) closes it.

### 2. One clock per request

Rule: every timing in a request comes from one clock that starts when the request arrives. Each step records its offset from that start.

Provides: nothing. The product measures its own timings. FLS keeps its clock in `apps/server/timeline.ts` in fls-ai-tool.

Tests: none.

Status: Not yet. PR 2 (clock) closes it.

### 3. Consistent span attributes

Rule: every attribute name follows one schema, and every product uses the same names for the same facts. Attributes carry counts and identifiers in place of free content where possible, and values have a fixed length limit.

Provides: node handles prefix each key as `app.<type>.<name>.<key>`. `set()` writes keys as given. A node handle takes an optional schema as its second argument, for example `tool('search', schema)`. With no schema, a handle writes every key as given. `user(id)` and `session(id)` set `enduser.id` and `session.id` on the active span. `src/legacy.ts` also writes the old names for tool and model nodes, with or without a schema. That dual-write is past its `LEGACY_EXPIRY` (2026-09-18). It stays because saved queries still read the old names, and fls-ai-tool#409 moves them.

Usage:

- Schema: the types are `NodeSchema` and `AttributeSpec` in `src/types.ts`. Each key declares one type: `enum` for states, `count` (a non-negative integer) in place of content, `number`, `boolean`, `string` or `string[]`. Declare the schema with `as const`, or inline, so TypeScript infers the allowed keys and value types for `set()`.
- Length limit: the handle cuts each string, and each item of a `string[]`, at the key's `maxLength`, else the schema's `maxLength`, else 1024. A cut also writes `<key>.truncated = true`.
- Invalid write: an undeclared key, a value of the wrong type or a value outside the enum is dropped. The handle adds the full attribute name to the `flywheel.attribute_error` string array on the span, once per name. It does not throw. `init({ strict: true })` throws a `TypeError` in its place. Use strict mode in tests only. See `src/schema.ts`.
- Rename: `renamedFrom: { from, until }` on a key also writes the value under the old name `from`. That stops at 00:00 UTC on the date `until` (YYYY-MM-DD). `init({ now })` replaces the clock, for tests.
- User and session ids: pass an opaque id, such as a random or hashed value. Do not pass personal data, such as a name, an email address or an Entra object id. An empty or non-string id is an invalid write.

Tests:

- `node handles keep string, number, boolean and array values as given`
- `set writes each key as given, with no prefix and no legacy key`
- `a later write to the same key replaces the earlier value`
- `LEGACY_EXPIRY is 2026-09-18`
- the three node handle cases listed under practice 1
- `a schema handle writes declared keys as app.<type>.<name>.<key>, with the same legacy keys`
- `a schema handle drops an undeclared key and names it in flywheel.attribute_error`
- `a schema handle drops an enum value outside the declared values and names the key`
- `a schema handle drops a value of the wrong type, and a count that is not a non-negative integer`
- `a schema handle cuts a string over the default limit of 1024 and sets <key>.truncated`
- `a per-key maxLength overrides the schema maxLength, which overrides the default`
- `flywheel.attribute_error names each dropped key once, across writes on one span`
- `in strict mode, an invalid write throws and writes nothing for that key`
- `a rename writes the old and new names before its expiry date, and only the new name from that date`
- `a rename sets <key>.truncated on both names when it cuts the value`
- `a schema handle infers the allowed keys and value types`
- `user(id) and session(id) set enduser.id and session.id on the active span`
- `user() and session() drop an empty or non-string id and name the key in flywheel.attribute_error`
- `with no active span, schema handles, user() and session() write nothing and do not throw`
- `the noop instance accepts a schema, user() and session(), and writes nothing`

Status: Met. The removal of the legacy dual-write waits for fls-ai-tool#409, in a follow-up PR.

### 4. Check the logging works first

Rule: at start-up, the product proves that telemetry reaches the backend before it serves traffic. A missing provider fails that check.

Provides: nothing. With no tracer provider or no active span, every write is a silent no-op. `flush()` resolves at once and does not flush the provider.

Tests (these describe the current gap):

- `flywheel() returns the noop instance before init()`
- `with no active span, every write is dropped and getTraceId() is undefined`
- `the noop instance writes nothing, even inside an active span`
- `flush() resolves to undefined on both instances`

Status: Not yet. PR 6 (`selfCheck`) closes it.

### 5. Each evaluator lists the data it needs

Rule: each evaluator declares the fields it `requires` and the values it `expects`. A check compares those lists with the fields the product writes.

Provides: nothing. The evaluator contracts live in the Flywheel repository.

Tests: none.

Status: Not yet. PR 6 (field manifest, checked against evaluator `requires`) closes it.

### 6. Feedback is attached to the turn

Rule: each piece of user feedback joins the trace of the turn it rates, so a reader finds both in one place.

Provides: `metadata(traceId, eventName, attrs)` emits one OpenTelemetry log record in the given trace (`src/metadata.ts`). It names the event with the Azure-specific key `microsoft.custom_event.name`. Its span id is the first 16 hex digits of the trace id, so it does not point to a span that exists. Langfuse does not ingest log records (see the Langfuse section).

Tests:

- `metadata emits one INFO log record on the flywheel logger, named by microsoft.custom_event.name`
- `metadata puts the record in the given trace, with the first 16 hex digits as its span ID`
- `metadata uses the given trace ID, not the active span`
- `metadata with a trace ID that is not 32 hex digits keeps the attributes and drops the trace`
- `an attribute named microsoft.custom_event.name replaces the event name`

Status: Partial. PR 5 (feedback as a span on the turn's trace) closes it.

### 7. Agents read the record and act

Rule: agents read the turn records, find faults and propose changes. A person approves every change.

Provides: nothing. The Flywheel owns this practice. See `docs/analysis-agent.md` and `docs/code-change-handoff.md` in the Flywheel repository.

Tests: none.

Status: Out of scope for this package.

## Failure layers

A fault in a turn belongs to one of three layers. Find the layer before you change anything.

| Layer | What fails | Example |
|---|---|---|
| Product | The product gives a wrong or poor answer | The answer cites the wrong source |
| Instrument | The telemetry is missing or wrong | A write with no active span is dropped |
| Evaluation | The evaluator scores a correct turn as wrong, or the reverse | An evaluator reads a field the product does not write |

## Backends

### Azure Monitor

- Exporter: `useAzureMonitor()` from `@azure/monitor-opentelemetry`, with the Application Insights connection string. FLS calls it in `apps/server/telemetry.mjs` in fls-ai-tool.
- Attribute limit: raise `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` from the SDK default of 128. FLS sets 1024. At 128, the SDK drops keys past the limit, with no error. The contract suite uses 1024 (`test/sdk.ts`).
- Where data lands (unverified from code; from the FLS query notes in `evals/flywheel/agent-knowledge/kql-patterns/tables.md`):
  - Incoming request spans go to `requests`. Attributes that node handles and `set()` write on the request span are in `customDimensions`.
  - AI SDK model call spans (`ai.*`) go to `dependencies`, linked by `operation_Id`.
  - `metadata()` log records go to `customEvents`, named by `microsoft.custom_event.name`, with the attributes in `customDimensions`.
  - A single dimension value is cut at about 8 KB.

### Langfuse

- Exporter: `LangfuseSpanProcessor` from `@langfuse/otel`, added to the tracer provider. FLS registers it on a `NodeTracerProvider` in `apps/server/telemetry.mjs` in fls-ai-tool, and runs it only when Azure Monitor is off.
- Spans become observations on a Langfuse trace.
- Token usage comes from the `gen_ai.*` attributes that AI SDK telemetry writes, when `aiSdkTelemetry()` turns it on.
- Langfuse ingests traces only. It does not ingest OpenTelemetry log records, so `metadata()` events do not arrive. PR 5 changes feedback to a span. The Flywheel writes its own feedback as spans for the same reason (`src/feedback/emit.ts` in the Flywheel repository).
- Unverified: how Langfuse shows `app.*` attributes (assumed: observation metadata).

## Rules for an agent changing this package

- Keep every case in `test/contract.ts` passing. Do not change an assertion to make a change pass. If a change of behaviour is intended, change the case in the same PR and say why in the PR body.
- Add a case to `test/contract.ts` for each new behaviour. Cases use `node:assert` and the SDK in `test/sdk.ts`, with no test framework globals, so any runner can run them.
- Keep the case that reads `flywheel()` before `init()` first in the list.
- Update the status lines and test lists in this file in the same PR.
- Run `npm run build`, `npm run typecheck` and `npm test` before you open a PR. CI runs the same steps on Linux.
- Do not copy code into this file. Reference the source file.

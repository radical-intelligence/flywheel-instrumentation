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
2. Call `init()` once, after the providers exist. It returns the live instance. On Azure Monitor, call `init({ azureCustomEvents: true })`, so feedback also reaches `customEvents` (see the Azure Monitor section).
3. Everywhere else, call `flywheel()`. Before `init()`, it returns a noop instance that writes nothing.

The public API is in `src/index.ts`, and the types are in `src/types.ts`. The subpath exports are in `src/express.ts` and `src/ai-sdk.ts` (see practice 2).

## Practices

The blueprint "Observability for agentic systems" has seven practices. Each rule below is independent of the backend. Each status names the PR in this repository that closes the gap. A conformance test is a case name in `test/contract.ts`.

### 1. One record per turn

Rule: each turn produces one record that holds its input, output, steps and timings. A reader can rebuild the turn from that record alone.

Provides: node handles (`tool(name)`, `model(name)`, `agent(name)`) and `set()` write to the active span. `getTraceId()` returns the trace that identifies the turn. `aiSdkTelemetry()` returns the AI SDK telemetry settings, so model calls join the same trace. There is no turn record type.

Tests:

- `tool(name).set writes app.tool.<name>.<key> only, with no app.<name>.<key>`
- `model(name).set writes app.model.<name>.<key> only, with no app.<key> or app.time_to_first_token_ms`
- `agent(name).set writes app.agent.<name>.<key> only`
- `writes go to the active span only`
- `getTraceId() returns the trace ID of the active span`
- `aiSdkTelemetry() on the live instance turns AI SDK telemetry on, with inputs and outputs`

Status: Partial. PR 4 (turn record) closes it.

### 2. One clock per request

Rule: every timing in a request comes from one clock that starts when the request arrives. Each step records its offset from that start.

Provides: a request timeline on one monotonic clock (`src/timeline.ts`). The timeline is kept in AsyncLocalStorage, so code deep in the call stack records spans with no extra parameters. Both instances (live and noop) carry the clock methods, because the clock writes no telemetry:

- `createTimeline(clock?)` returns a `RequestTimeline`. It starts at `performance.now()`, or at `clock()` when given.
- `runWithTimeline(tl, fn)` makes `tl` the current timeline for `fn`.
- `timeline()` returns the current timeline handle (`span`, `timed`, `scope`, `annotate`, `mark`, `markLast`, `set`). Outside a timeline, the handle records nothing.
- `timed(name, fn, attrs?)` records `fn` as a span. Every span inside `fn` takes `name` as a prefix.
- `recordUsage(tl, usage, marks)` records token counts and the visible output rate.
- `timelineAttributes(payload)` flattens `RequestTimeline.toJSON()` into `app.timeline.*` attributes. Pass the result to `set()`, so the response and the request span hold the same timeline.

Two subpath exports hold the parts that depend on another library. Each library is an optional peer dependency:

- `@radical-intelligence/flywheel-instrumentation/express` (`src/express.ts`): `startTimeline` is the first middleware. It starts the clock and opens the `request` span. `timedMiddleware(name, mw)` records a middleware as a span. `requestTimeline(res)` returns the timeline for the response. Call `endRequest()` on it after the last write.
- `@radical-intelligence/flywheel-instrumentation/ai-sdk` (`src/ai-sdk.ts`): `recordStreamPart(tl, part, toolNames)` marks the first chunk, the first text, reasoning, each tool input window and the last token. It reads the AI SDK 5 stream part names.

The legacy timing fields and the SSE `timings` frame stay in FLS (`apps/server/timeline.ts` in fls-ai-tool).

Tests:

- `a timeline records spans as offsets from its start, in start order`
- `a repeated span name gets a #n suffix, and a span still open is left out`
- `mark keeps the first time, markLast keeps the last, and set drops a value that is not finite`
- `timeline() records nothing outside a request`
- `timed spans take the scope as a prefix, across awaits and parallel work`
- `a timed span closes when its work throws`
- `sequential step offsets add up to the request time on a fake clock`
- `sequential step offsets add up to the request wall-clock time on the real clock`
- `startTimeline starts the clock, and timedMiddleware times a middleware and restores the timeline in next`
- `startTimeline opens a request span at zero that closes on endRequest, once`
- `timedMiddleware passes a middleware error to next`
- `timedMiddleware runs the middleware untimed when no timeline is attached`
- `recordStreamPart marks the first chunk, first text, reasoning, the tool input window and the last token`
- `recordUsage records token counts and output tokens per second over the visible stream`
- `recordUsage leaves out the rate when no visible token was marked`
- `timelineAttributes flattens the timeline into app.timeline.* attributes`
- `the response payload and the request span hold the same timeline`
- `the noop instance keeps the clock, and writes no attributes`

Status: Met.

### 3. Consistent span attributes

Rule: every attribute name follows one schema, and every product uses the same names for the same facts. Attributes carry counts and identifiers in place of free content where possible, and values have a fixed length limit.

Provides: node handles prefix each key as `app.<type>.<name>.<key>`. `set()` writes keys as given. A node handle takes an optional schema as its second argument, for example `tool('search', schema)`. With no schema, a handle writes every key as given. `user(id)` and `session(id)` set `enduser.id` and `session.id` on the active span. Apart from a schema rename (see Rename below), node handles write no other name. The legacy dual-write (`app.<name>.<key>` for tools, `app.<key>` for models) is removed. fls-ai-tool#411 moved the saved queries to the new names (merged into dev as 89352d2).

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
- the three node handle cases listed under practice 1
- `a schema handle writes declared keys as app.<type>.<name>.<key> only`
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

Status: Met.

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

Provides: `turnRef()` returns the trace ID and span ID of the active span. The product calls it during the turn and stores the ref with the response. `feedback(event)` writes the event as one span (`src/feedback.ts`, types in `src/types.ts`):

- With a valid `turn` ref, the span joins the turn's trace, and its parent is the turn span.
- With no `turn` ref, or an invalid one, the span joins a per-session trace. The trace ID and parent span ID derive from the `session` id, so every process puts one session's events on one trace. That parent span is never written. With no `session`, the event joins one session per process. Flywheel's `src/feedback/emit.ts` uses the same rule.
- The span is `INTERNAL`, on the `flywheel` tracer, and starts and ends at `at` (default now).

Event kinds, after Flywheel ADR 005 (`docs/adrs/005-implicit-user-feedback.md` and `src/feedback/events.ts` in the Flywheel repository):

| Kind | ADR 005 class | Typed attributes |
|---|---|---|
| `rating` | `explicit` | `rating`, `rating.<criterion>`, `reason`, `reasons` (joined with commas), `comment` |
| `decision` | `decision` | `decision`, `reason` |
| `edit` | `decision` | `edit.draft`, `edit.text` |
| `dwell` | `ui` | `element`, `dwell_ms` |
| `next_message` | `conversation` | `next_message` |

- Every event also writes `kind`, `class`, `session`, and the `subject.*` and `actor.*` fields it has.
- Each typed attribute has the prefix `namespace.`, default `feedback`. So a rating writes `feedback.rating`, `feedback.reason` and `feedback.reasons`, as FLS's saved queries read them.
- FLS tester feedback sets `namespace: 'tester'` and puts its scores in `ratings`, which writes `tester.rating.<criterion>` and `tester.comment`. Its other `tester.*` keys go in `attributes`.
- `attributes` are written as given, after the typed ones.
- `event.name` is the event `name`, default `feedback.<kind>`. It is also the span name, and no attribute replaces it.

`metadata(traceId, eventName, attrs)` stays, deprecated in favour of `feedback()`. It emits one OpenTelemetry log record in the given trace (`src/metadata.ts`). It names the event with `microsoft.custom_event.name`. Its span id is the first 16 hex digits of the trace id, so it does not point to a span that exists.

Tests:

- `turnRef() returns the trace ID and span ID of the active span`
- `turnRef() is undefined with no active span`
- `feedback joins its turn's trace as a child of the turn span`
- `feedback joins its turn, not the span active when it is written`
- `a rating writes event.name and the feedback.* attributes FLS queries read`
- `namespace writes the typed attributes under its prefix, so tester ratings keep tester.*`
- `each behaviour signal writes its kind, its ADR 005 class and its typed attributes`
- `an attribute cannot replace event.name`
- `feedback with no turn ref joins one trace per session, the same for every event in it`
- `feedback with an invalid turn ref joins its session's trace`
- `feedback with no turn ref and no session joins one trace for the process`
- `feedback starts and ends its span at the at time`
- `feedback writes no log record by default`
- `with azureCustomEvents, feedback also emits a log record named by microsoft.custom_event.name, in the feedback span`
- `the noop instance drops feedback, and its turnRef() is undefined`
- `metadata emits one INFO log record on the flywheel logger, named by microsoft.custom_event.name`
- `metadata puts the record in the given trace, with the first 16 hex digits as its span ID`
- `metadata uses the given trace ID, not the active span`
- `metadata with a trace ID that is not 32 hex digits keeps the attributes and drops the trace`
- `an attribute named microsoft.custom_event.name replaces the event name`

Status: Met.

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
  - A single dimension value is cut at about 8 KB.
- Where feedback lands. These rows are confirmed from the exporter code (`@azure/monitor-opentelemetry-exporter` 1.0.0-beta.44, `dist/esm/utils/spanUtils.js` and `dist/esm/utils/logUtils.js`), not from a live resource:
  - The `feedback()` span is `INTERNAL`, so it goes to `dependencies`. Its `operation_Id` is the turn's trace ID, and its `operation_ParentId` is the turn span ID.
  - With `init({ azureCustomEvents: true })`, `feedback()` also emits a log record with `microsoft.custom_event.name` set to the event name. It goes to `customEvents`, with `name` set to the event name and the attributes in `customDimensions`. Its `operation_Id` is the turn's trace ID, and its `operation_ParentId` is the feedback span ID.
  - `metadata()` log records go to `customEvents` the same way. Their `operation_ParentId` is the first 16 hex digits of the trace ID.
  - FLS's saved queries (`user_feedback.kql` and `tester_feedback.kql` in fls-ai-tool) read `customEvents` by `name` and `customDimensions`. They keep working when FLS moves from `metadata()` to `feedback()` with `azureCustomEvents`, the same event names and the attribute mapping under practice 6.

### Langfuse

- Exporter: `LangfuseSpanProcessor` from `@langfuse/otel`, added to the tracer provider. FLS registers it on a `NodeTracerProvider` in `apps/server/telemetry.mjs` in fls-ai-tool, and runs it only when Azure Monitor is off.
- Spans become observations on a Langfuse trace.
- Token usage comes from the `gen_ai.*` attributes that AI SDK telemetry writes, when `aiSdkTelemetry()` turns it on.
- Langfuse ingests traces only. It does not ingest OpenTelemetry log records, so `metadata()` events and the `azureCustomEvents` log records do not arrive.
- A `feedback()` span becomes an observation on the turn's trace, under the turn span's observation. The Flywheel writes its own feedback as spans for the same reason (`src/feedback/emit.ts` in the Flywheel repository).
- Feedback with no turn ref becomes an observation on the session's trace. That trace has no root observation, because the parent span is never written. Unverified: how Langfuse shows an observation whose parent is missing (assumed: at the top level of the trace).
- Unverified: how Langfuse shows `app.*` attributes (assumed: observation metadata).

## Rules for an agent changing this package

- Keep every case in `test/contract.ts` passing. Do not change an assertion to make a change pass. If a change of behaviour is intended, change the case in the same PR and say why in the PR body.
- Add a case to `test/contract.ts` for each new behaviour. Cases use `node:assert` and the SDK in `test/sdk.ts`, with no test framework globals, so any runner can run them.
- Keep the case that reads `flywheel()` before `init()` first in the list.
- Update the status lines and test lists in this file in the same PR.
- Run `npm run build`, `npm run typecheck` and `npm test` before you open a PR. CI runs the same steps on Linux.
- Do not copy code into this file. Reference the source file.

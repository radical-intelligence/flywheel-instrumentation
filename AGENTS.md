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
2. Call `init()` once, after the providers exist. It returns the live instance and runs the self-check (practice 4). Pass the product's node schemas as `init({ schemas })`, so the check and the manifest (practice 5) know them. On Azure Monitor, call `init({ azureCustomEvents: true })`, so feedback also reaches `customEvents` (see the Azure Monitor section).
3. Everywhere else, call `flywheel()`. Before `init()`, it returns a noop instance that writes nothing.

The public API is in `src/index.ts`, and the types are in `src/types.ts`. The subpath exports are in `src/express.ts` and `src/ai-sdk.ts` (see practice 2), and `src/manifest.ts` (see practice 5).

## Practices

The blueprint "Observability for agentic systems" has seven practices. Each rule below is independent of the backend. Each status names the PR in this repository that closes the gap. A conformance test is a case name in `test/contract.ts`.

### 1. One record per turn

Rule: each turn produces one record that holds its input, output, steps and timings. A reader can rebuild the turn from that record alone.

Provides: `turn(options, fn)` opens the turn's root span and runs `fn` with that span active (`src/turn.ts`). Model calls inside `fn` become its children: AI SDK spans through `aiSdkTelemetry()`, or manual spans. `fn` fills `turn.record`, a typed `TurnRecord`. When `fn` settles, the record goes on the root span. Node handles (`tool(name)`, `model(name)`, `agent(name)`) and `set()` write to the active span. `getTraceId()` returns the trace that identifies the turn.

Usage:

- Span: the name is `invoke_agent {agent}`, of kind INTERNAL. It carries `gen_ai.operation.name = invoke_agent`, `gen_ai.agent.name` and, when given, `gen_ai.conversation.id`. The names follow the OpenTelemetry GenAI semantic conventions in `@opentelemetry/semantic-conventions` 1.43.0 (incubating). The package writes them as strings and does not import that package. Inside an active request span, the turn span is its child.
- Record: the types are `TurnRecord`, `TurnMessage`, `TurnOptions` and `Turn` in `src/turn.ts`. Fields that Flywheel's `TurnOutput` also has keep its names (`query`, `answer`, `messages`, `toolCalled`, `model`, `ms`, `timings`). A tool result is a message with the role `tool` and a `toolName`.
- Outcome: `answered`, `refused`, `error` or `aborted`. When `fn` resolves, the default is `answered`, and a value the caller set stays. When `fn` throws, the outcome is `error`, or `aborted` for an error named `AbortError`. The span status is ERROR, the exception is recorded, and the error is rethrown.
- Attributes: `TURN_ATTRIBUTES` in `src/turn.ts` lists every name with its spec. `<name>` and `<step>` stand for the guardrail names and the timing keys. The record writes `app.turn.*`, plus `gen_ai.request.model` and `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`. Guardrails write `app.turn.guardrail.<name>.passed` and `.reason`. Timings write `app.turn.timing.<step>`.
- Length limit: each string is cut at `options.maxLength` (default 1024) and sets `<key>.truncated`. Each message content is cut on its own, so `app.turn.messages` stays valid JSON, and a cut sets `app.turn.messages.truncated`. Tool call inputs are not cut. Set `maxLength` above the longest answer to keep the whole conversation.
- Messages: `app.turn.messages` is a JSON array in the shape FLS writes to `app.model.legal-analysis.messages` (`role`, `content`, `toolCalls` with `toolName` and `input`). A reader of the old attribute reads the new one with the name changed only.
- Timings and usage: pass the request clock as `options.timeline`. Its closed spans fill `timings` with their durations, and its `inputTokens` and `outputTokens` fill `usage`, when the record leaves them out.
- Feedback: `turn.ref` holds the trace ID and span ID of the root span, as a `TurnRef`. Store it with the answer, and pass it as `feedback({ turn })`, so the feedback span is a child of the turn span (practice 6). Inside `fn`, `turnRef()` returns the same ref until a child span is active.
- Manifest: `turn()` registers `TURN_ATTRIBUTES` under the source `turn` on each call. So that the start-up self-check and the manifest file list the names before the first turn, call `registerAttributes('turn', TURN_ATTRIBUTES)` in the schema module. Both come from the `./manifest` subpath (practice 5).
- Invalid write: an outcome outside the enum, or a timing or token count of the wrong type, is dropped and named in `flywheel.attribute_error`, as for a schema handle.
- Noop instance: `turn()` runs `fn` with a record that nothing writes, and `turn.ref` is undefined.

Tests:

- `one turn and two model calls export as one trace, the root named invoke_agent {agent}, the calls its children`
- `turn() writes gen_ai.operation.name, gen_ai.agent.name and gen_ai.conversation.id on the root span`
- `inside an active span, the turn span is its child`
- `the turn record goes on the root span when the turn ends`
- `turn() cuts each string and each message content at maxLength, sets .truncated, and keeps the messages JSON valid`
- `an error inside the turn sets the outcome to error and the span status, and is rethrown`
- `an AbortError inside the turn sets the outcome to aborted`
- `a caller outcome stays, and an outcome outside the enum is dropped and named in flywheel.attribute_error`
- `the request timeline fills the turn timings and usage when the record leaves them out`
- `turn.ref holds the trace ID and span ID of the root span`
- `feedback with turn.ref as its turn is a child of the turn span`
- `the noop instance runs the turn and returns its result, and writes nothing`
- `manifest() lists the turn names once the turn attributes are registered`
- `every name a turn writes is in the manifest, with <name> and <step> standing for the caller keys`
- `tool(name).set writes app.tool.<name>.<key> only, with no app.<name>.<key>`
- `model(name).set writes app.model.<name>.<key> only, with no app.<key> or app.time_to_first_token_ms`
- `agent(name).set writes app.agent.<name>.<key> only`
- `writes go to the active span only`
- `getTraceId() returns the trace ID of the active span`
- `aiSdkTelemetry() on the live instance turns AI SDK telemetry on, with inputs and outputs`

Status: Met. FLS still writes its turn through `model('legal-analysis')`. Moving it to `turn()` is a change in fls-ai-tool.

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

Provides: `selfCheck()` checks the telemetry setup and returns a `SelfCheckReport` (`src/selfCheck.ts`, types in `src/types.ts`). `init()` runs the same check. The checks:

- Tracer provider: the global tracer provider is a proxy. The proxy gives a delegate tracer only after a provider is registered, so no delegate is an error (`no_tracer_provider`).
- Logger provider: the check asks the `flywheel` logger `enabled()`. With no provider, the API logger answers false. The check fails on it (`no_logger_provider`) only with `init({ requireLoggerProvider: true })`. The default is the value of `azureCustomEvents`. An `@opentelemetry/api-logs` version with no `Logger.enabled()` gives a warning in its place.
- Start-up span: one `INTERNAL` span named `flywheel.startup`, on the `flywheel` tracer, in a new trace. It carries `flywheel.version`, `flywheel.schema.node_count`, `flywheel.schema.attribute_count`, `flywheel.attribute_count_limit`, `flywheel.self_check.ok` and `flywheel.self_check.issues`. A sampler that drops it gives a warning.
- Attribute count: the check counts the manifest names for each node and for the whole turn. A count over the span attribute count limit gives a warning, because the SDK drops the keys past the limit with no error. The SDK tracer reports the limit through `getSpanLimits()`. With another tracer, the check reads `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`, else uses 128.
- Value size: a declared `maxLength` over the exporter value size limit gives a warning. The limit is `init({ valueSizeLimit })`, default 8192 bytes. That default is the Azure Monitor custom dimension cap. Other exporters have other limits. `maxLength` counts characters, so text that is not ASCII can pass the check and still go over the limit.

Usage:

- Failure: an error sets `ok: false`. `init()` writes each error with `console.error` and each warning with `console.warn`, then returns the live instance. A failed check never stops the product by default. `init({ strict: true })` throws on a failed check and keeps the previous instance. Use strict mode in tests only.
- Start-up span: `init()` emits it on the first call in the process that finds a tracer provider. Each `selfCheck()` call emits one.
- The noop instance reports `ok: false` with `not_initialised`, and emits nothing.
- Query-side checks: the start-up span proves only that the SDK has the span. The backend checks below prove that the data arrived and that it joins. Run them after each deploy, and on a schedule.

| Check | Rule |
|---|---|
| Start-up | At least one `flywheel.startup` span in the last 15 minutes after a deploy or a restart. |
| Users | More than one distinct `enduser.id` over one day of traffic. One value means every turn has the same id, for example a service account. |
| Feedback join | A join from feedback to turns keeps every feedback row. A row with no turn means the turn ref was lost. |
| Attribute limit | No exported turn has as many attributes as the span attribute count limit. A turn at the limit has lost keys. |

Azure Monitor (KQL, Application Insights). Each query ran against the FLS dev resource on 2026-10-13. That resource has no `flywheel.startup` span yet, so the first query returned zero rows:

- Start-up: `union requests, dependencies | where timestamp > ago(15m) | where name == 'flywheel.startup' | summarize startups = count(), latest = max(timestamp)`
- Users: `requests | where timestamp > ago(1d) | where isnotempty(user_AuthenticatedId) | summarize users = dcount(user_AuthenticatedId)`. The exporter writes `enduser.id` to `user_AuthenticatedId`, not to `customDimensions`.
- Feedback join: `let feedback = customEvents | where timestamp > ago(1d) | where name in ('user_feedback', 'tester_feedback') | project operation_Id, fb = itemId; let turns = requests | where timestamp > ago(2d) | summarize by operation_Id, turn = true; feedback | join kind=leftouter turns on operation_Id | summarize feedback = dcount(fb), rows = count(), joined = countif(turn == true)`. It passes when the three counts are equal. With `feedback()` spans and no `azureCustomEvents`, read the feedback from `dependencies` by name.
- Attribute limit: `requests | where timestamp > ago(1d) | extend keys = array_length(bag_keys(customDimensions)) | summarize maxKeys = max(keys), atLimit = countif(keys >= 1024)`. Replace 1024 with the configured limit. It passes when `atLimit` is 0.

Langfuse (public API v2, basic auth with the project keys). Organisations created from 2026-09-16 have only the v2 API. Each request ran against a Langfuse project on 2026-10-13, which checks the request shape. None ran against a product that uses this package:

- Start-up: `GET /api/public/v2/observations?name=flywheel.startup&fromStartTime=<15 minutes ago>&toStartTime=<now>&limit=1`. It passes when `data` is not empty.
- Users: `GET /api/public/v2/metrics?query=<{"view":"observations","metrics":[{"measure":"uniqueUserIds","aggregation":"count"}],"dimensions":[],"filters":[],"fromTimestamp":"<1 day ago>","toTimestamp":"<now>"}>`. It passes when `count_uniqueUserIds` is over 1. Unverified: Langfuse fills `userId` from `user.id` or `langfuse.user.id`. Whether it also reads `enduser.id` is not known, so the count can be 0 with correct telemetry.
- Feedback join: `GET /api/public/v2/observations?name=user_feedback&fromStartTime=<1 day ago>&toStartTime=<now>`, then for each row `GET /api/public/v2/observations?traceId=<traceId>`. It passes when each `parentObservationId` is an observation in its trace. Unverified: no feedback row from this package was in the project.
- Attribute limit: `GET /api/public/v2/observations?fromStartTime=<1 day ago>&toStartTime=<now>&fields=core,metadata`, then count the `metadata` keys of each turn observation. Unverified: the metadata also holds resource and scope keys, so the count is an upper bound.

Tests:

- `flywheel() returns the noop instance before init()`
- `the first init() with a tracer provider emits one flywheel.startup span, at the root, with the version and schema counts`
- `a later init() emits no startup span, and selfCheck() emits one on each call`
- `with a tracer and a logger provider, selfCheck() reports ok with no issues`
- `with no tracer provider, selfCheck() fails with no_tracer_provider and init() writes it to the console`
- `in strict mode, init() throws when the self-check fails, and flywheel() keeps the previous instance`
- `with requireLoggerProvider or azureCustomEvents, selfCheck() fails with no logger provider`
- `selfCheck() warns when a node or the turn declares more names than the SDK attribute count limit, and stays ok`
- `with no SDK limit, selfCheck() reads OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT, else the default of 128`
- `selfCheck() warns when a declared maxLength exceeds the value size limit, 8192 by default`
- `the noop instance selfCheck() fails with not_initialised and emits no span`
- `with no active span, every write is dropped and getTraceId() is undefined`
- `the noop instance writes nothing, even inside an active span`
- `flush() resolves to undefined on both instances`

Status: Met.

### 5. Each evaluator lists the data it needs

Rule: each evaluator declares the fields it `requires` and the values it `expects`. A check compares those lists with the fields the product writes.

Provides: `manifest()` returns an `InstrumentationManifest`: every attribute name the product can write on a turn span, sorted by name (`src/manifest.ts`, types in `src/types.ts`). It lists:

- For each key of each schema in `init({ schemas })`: `app.<type>.<name>.<key>`, its `.truncated` flag for a string or a string array, and the old name of a rename with `until`. The old name has `aliasOf`, the name it repeats.
- The core names: `enduser.id`, `session.id` and `flywheel.attribute_error`.
- The names that other modules add with `registerAttributes(source, attributes)`, from the `./manifest` subpath. Each key is a full attribute name with an `AttributeSpec`. A second call with the same source replaces the first.

Each entry has `name`, `type` and `source`, and `values` for an enum and `maxLength` for a string. Names that a product writes with `set()` or a handle with no schema are not in the manifest, unless the product registers them. That includes the `app.timeline.*` names (practice 2).

Usage:

- The product keeps its node schemas in one module, and exports them as `schemas` (or as the default export), typed `NodeSchemas`. The product passes the same object to `init({ schemas })`.
- The `flywheel-instrumentation-manifest` command imports that module and writes `instrumentation-manifest.json` (`src/cli.ts`): `npx flywheel-instrumentation-manifest <schema-module> [--out <file>]`. A TypeScript module needs a loader: `node --import tsx node_modules/.bin/flywheel-instrumentation-manifest <schema-module>`.
- `flywheel check` in the Flywheel repository reads the file and compares it with each evaluator's `requires` (see `docs/evaluators.md` there).
- The noop instance lists no names, because it writes none.

Tests:

- `manifest() lists each declared name with its type, the truncated flags, renames and the core names`
- `manifest() lists no legacy app.<name>.<key> or app.<key> names for tool and model keys`
- `every name a schema handle writes is in the manifest`
- `registerAttributes() adds a module's names to every manifest, and a second call replaces them`
- `manifest() lists the turn names once the turn attributes are registered`
- `every name a turn writes is in the manifest, with <name> and <step> standing for the caller keys`
- `the noop instance manifest() lists no names`
- `writeManifestFile() imports a schema module and writes its manifest as JSON`
- `VERSION equals the version in package.json`

Status: Met.

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
- Keep the case that reads `flywheel()` before `init()` first in the list, and the case that reads the start-up span of the first `init()` second.
- Update the status lines and test lists in this file in the same PR.
- Run `npm run build`, `npm run typecheck` and `npm test` before you open a PR. CI runs the same steps on Linux.
- Do not copy code into this file. Reference the source file.

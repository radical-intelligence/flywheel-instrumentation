# AGENTS.md: conformance

This file is for an AI agent that ports the package to another language, or that changes the behaviour of the package.

The scenarios in this folder are the language-neutral specification of the package. Each scenario is a script of steps. Each expected file is the telemetry that the script exports, after normalisation. A compliant port runs every scenario with its own runner, and writes the same bytes as the expected file. Where `src/`, the root `AGENTS.md` and these fixtures differ, the fixtures are the specification.

## Files

| File | What it holds |
|---|---|
| `scenarios/<name>.json` | One scenario: its setup and its steps. `covers` lists the documented behaviours it checks, each with its practice number in the root `AGENTS.md`. |
| `expected/<name>.json` | The normalised output of the scenario. It is generated from the TypeScript package and reviewed by hand. |
| `scenario.schema.json` | The scenario vocabulary, as JSON Schema (draft 2020-12). Each step has a description. |
| `output.schema.json` | The output shape and the normalisation rules, as JSON Schema. |
| `runner.ts` | The TypeScript runner. It checks each scenario and each output against the schemas, and compares each output with its expected file. |
| `execute.ts` | Runs one scenario in one process, for `runner.ts`. |
| `normalise.ts` | The normalisation for the TypeScript runner. |
| `scenario.ts` | The TypeScript types of the vocabulary. |

```bash
npm run conformance          # compare every scenario with its expected file
npm run conformance:update   # write the expected files from this package
```

`npm test` runs `npm run conformance`.

## How a scenario runs

1. Start a new process. `init()`, the start-up span, the registered manifest names and the process session are state of the process, so no scenario shares them.
2. Remove every `OTEL_*` environment variable, then set the variables in `setup.env`.
3. Install the scenario clock (see below).
4. Register a context manager. Register an SDK tracer provider when `setup.tracerProvider` is true, with the sampler in `setup.sampler`, the span attribute count limit in `setup.attributeCountLimit`, and an in-memory exporter that exports each span when it ends. Register an SDK logger provider when `setup.loggerProvider` is true, with an in-memory exporter that exports each record when it is emitted.
5. Run the steps in order. Wait for each step to finish before the next step starts. Each step calls `flywheel()` to get the current instance, as product code does.
6. Flush the providers, normalise the output, and write it as canonical JSON.

### The scenario clock

The scenario clock drives every clock that the package and the SDK read:

- The wall clock reads `setup.clock` plus the time that `advanceClock` steps added. Span start times, log record times and the default feedback time come from it.
- The monotonic clock reads zero plus the same added time. Span durations, the turn duration (`app.turn.ms`) and the request timeline come from it.
- The `init` step passes the wall clock as the rename clock (`init({ now })`).

Time moves only in an `advanceClock` step. So every timestamp, duration and timeline offset in an expected file is exact. In the TypeScript runner, `execute.ts` replaces `Date` and `performance.now()`. A port replaces the clocks that its SDK and its package read.

### Steps

`scenario.schema.json` defines each step and its fields. Each step writes one result to the output, when it ends. A step with nested steps (`span`, `turn`, `withTimeline`, `timed`, `scope`) ends after them.

| Step | What it does | Result fields |
|---|---|---|
| `init` | `init(options)`, with the rename clock added | `console`, `error` |
| `span` | Starts a span on the tracer `conformance`, runs the nested steps with it active, and ends it. It stands in for a request, a model call or a tool call | none |
| `turn` | `turn(options, fn)`. `fn` stores `turn.ref`, runs the nested steps, writes `record`, throws `throw`, and returns `return` | `ref`, `returned` or `error` |
| `handle` | `tool`, `model` or `agent` with the name and the schema, then `set(attributes)` on the handle | `error` |
| `set`, `user`, `session` | The instance method with the given value | `error` |
| `getTraceId`, `turnRef` | The instance method. `turnRef` stores the ref under `ref` | `value` or `ref` |
| `feedback` | `feedback(event)`. `turn` names a stored ref | none |
| `metadata` | `metadata(traceId, eventName, attributes)`. `traceIdOf` takes the trace ID of a stored ref | none |
| `selfCheck`, `manifest`, `flush` | The instance method | `value` |
| `registerAttributes` | `registerAttributes(source, attributes)` from the manifest module | none |
| `advanceClock` | Moves both clocks forward by `ms` | none |
| `env` | Sets or removes environment variables | none |
| `withTimeline` | Creates a timeline on the default clock, opens its request span when `request` is true, and runs the nested steps with it as the current timeline | none |
| `endRequest` | Closes the request span of a stored timeline | none |
| `timed`, `scope` | `timed(name, fn, attributes)` or `timeline().scope(name, fn)`. `fn` runs the nested steps. `timed` then throws `throw` | `error` |
| `timelineSpan`, `timelineClose` | `timeline().span(name, attributes)`, and the close function it returns | none |
| `annotate`, `mark`, `markLast`, `timelineSet` | The method of `timeline()` | none |
| `recordUsage` | `recordUsage(timeline(), usage, marks)`, with the marks of a stored timeline | none |
| `timelineJSON` | The payload of a stored timeline | `value` |
| `setTimelineAttributes` | `set(timelineAttributes(payload))` with the payload of a stored timeline | `value` |

A step that throws records `error` with the name and the message, and the scenario continues. Any step can have `error`.

Two JSON objects stand for values that JSON cannot write, or writes only at length. Decode them before the step runs:

- `{ "$repeat": { "text": "a", "count": 1030 } }` is the text repeated `count` times.
- `{ "$number": "NaN" }` is that number. The other values are `Infinity` and `-Infinity`.

## Normalisation

`output.schema.json` gives each rule on the field it applies to. In short:

- Spans are in the order they ended. Log records are in the order they were emitted. Results are in the order the steps ended.
- A span is named by its path: the names of its exported ancestors and its own, joined by ` > `. A repeated name under one parent gets ` #2`, ` #3`, and so on.
- Trace IDs become `trace-1`, `trace-2`, and so on, in order of first use. The span ID of an exported span becomes `span:<path>`. Other span IDs become `external-1`, `external-2`, and so on.
- Feedback with no valid turn ref derives its trace ID and parent span ID from the session. The derived IDs become `session-trace:<session>` and `session-span:<session>`. So a port must use the same rule: the SHA-256 hex digest of `flywheel-feedback-session:<session>`, the first 32 digits for the trace ID and the next 16 for the span ID.
- A span ID that is the first 16 hex digits of a trace ID becomes `prefix:<trace label>`. `metadata()` writes such a span ID.
- Times are milliseconds from the start of the scenario clock, rounded to three decimal places.
- Placeholders replace the values that differ by port or by run: `flywheel.version` and the manifest package version are `<version>`, the manifest package name is `<package>`, `exception.stacktrace` is `<stacktrace>`, and the session that the package chose for the process is `<process-session>`.
- The span kind and the status code are names (`INTERNAL`, `ERROR`). The scope is the tracer or logger name, with no version.

### Canonical JSON

The output file is JSON with:

- Object keys sorted by UTF-16 code unit.
- Two spaces of indent, LF line ends, and one LF at the end.
- Numbers as ECMAScript writes them: the shortest form that reads back as the same double, so `40` and not `40.0`.
- Non-ASCII characters written as they are, not escaped.
- An absent value (`undefined`, `None`) written as `null` where the field exists.

String attribute values are compared as they are. For example, `app.turn.messages` is compact JSON, with the message keys in the order the scenario gives them.

## Write a runner for a port

1. Parse each scenario, and check it against `scenario.schema.json`.
2. Run it in a new process, as "How a scenario runs" says. Map each step to the port's API. Keep the step results in the order the steps end.
3. Export to in-memory exporters. Read the spans and the log records in export order.
4. Normalise the output, and check it against `output.schema.json`.
5. Write it as canonical JSON, and compare it with `expected/<name>.json` byte for byte. Report the first line that differs.

A port passes when every scenario matches. A port must not change an expected file. When a port cannot match a value, report it to the package owner: the fix is a change to the package and the fixture together, or a new normalisation rule.

Notes for a port:

- Rounding: the package rounds timeline offsets and the output rate to one decimal place, and the turn duration to a whole number, with a half rounded up (`Math.round`).
- The exception event of a failed turn has three attributes: `exception.type` (the error name), `exception.message` and `exception.stacktrace`.
- Each message and console text is part of the specification.
- The scenarios use ASCII text only, so they do not fix how a length limit counts other text.

## TypeScript only

These behaviours depend on a JavaScript library or on the module system, so no scenario covers them. `test/contract.ts` and `test/example.test.ts` check them:

- `aiSdkTelemetry()`, the AI SDK spans, and `recordStreamPart()` in `src/ai-sdk.ts`.
- The Express middleware in `src/express.ts`.
- `writeManifestFile()` and the `flywheel-instrumentation-manifest` command.
- The package exports, `VERSION` against `package.json`, and the schema type inference.
- `logger_provider_unknown`, which needs an `@opentelemetry/api-logs` version with no `Logger.enabled()`.
- Timed work in parallel, and the timeline on the real clock.

A port gives each of these its own tests, in the terms of its own libraries.

## Change the behaviour

1. Change `src/`, and the cases in `test/contract.ts`.
2. Add or change a scenario for the behaviour. Keep its `covers` list current.
3. Run `npm run conformance:update`, and review each changed expected file against the root `AGENTS.md`. A fixture that encodes a bug is a defect.
4. Say in the PR body which fixtures changed and why. Each port must then change too.

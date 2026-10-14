# AGENTS.md: the example agent

This file is for an AI agent that builds observability into an agentic product. This example is the blueprint for an instrumented agent. Start a new agent from it, or copy its pattern into an existing product. Keep each principle below when you change it.

The package contract is in `AGENTS.md` at the repository root. This file says where the example meets each principle, and how to extend it without breaking one.

## What the example is

A small agent that answers office questions. The model calls one tool, `lookup`, which searches three hard-coded facts, then answers with the result.

| Endpoint | What it does |
|---|---|
| `POST /chat` | Runs one agent turn. Returns the answer and the turn ref. |
| `POST /feedback` | Rates a turn. Takes the turn ref that `/chat` returned. |

## Stack

| Layer | Package |
|---|---|
| Language | TypeScript on Node |
| HTTP server | Express 5 |
| Agent loop and tools | Vercel AI SDK 5 (`streamText`, `tool`, `stopWhen`) |
| Model | AI SDK mock model by default. An OpenAI model when `EXAMPLE_OPENAI_MODEL` and `OPENAI_API_KEY` are set |
| Tool input schema | Zod 4 |
| Telemetry | OpenTelemetry SDK. Console exporters by default |
| Instrumentation | This package, imported by its name |

The example runs with no API key and no network.

## Files

| File | Responsibility |
|---|---|
| `telemetry.ts` | Registers the trace and log providers, the context manager and the attribute limit. The only file that knows the backend |
| `schemas.ts` | The schema module: every node schema, exported as `schemas` |
| `main.ts` | Start-up order: telemetry, `init({ schemas })`, self-check, serve |
| `app.ts` | The routes: the turn, the timeline, the node handles and the feedback |
| `model.ts` | The model. Mock by default |
| `test/example.test.ts` (repository root) | Starts the agent, sends one chat and one feedback, and checks the exported spans |

## Run it

```bash
npm run build                # the example imports dist/
npm run example              # port 3000, spans and log records on the console
npm run example:manifest     # writes instrumentation-manifest.json
npm test                     # includes the example test
```

## The principles

These are the seven practices of the blueprint "Observability for agentic systems". Each rule is independent of the backend.

### 1. One record per turn

Rule: each turn produces one record that holds its input, output, steps and timings. A reader can rebuild the turn from that record alone.

In the example: `/chat` in `app.ts` runs the whole turn inside `fw.turn()`. It fills `turn.record` with the query, every message (tool calls and tool results included), the answer and a guardrail result. The AI SDK spans are children of the turn span.

When you extend it: put all work for a turn inside `turn()`. Add new facts to `turn.record` or to a node handle. Do not write a second record for the same turn.

### 2. One clock per request

Rule: every timing in a request comes from one clock that starts when the request arrives. Each step records its offset from that start.

In the example: `startTimeline` is the first middleware. Other middleware is wrapped in `timedMiddleware`. The tool and the model call run inside `fw.timed()`. `recordStreamPart` marks the first chunk, the tool input window and the last token. `recordUsage` records the tokens. The route calls `endRequest()` after the response, then writes the timeline onto the turn span.

When you extend it: wrap each new step in `fw.timed()`. Do not call `Date.now()` or `performance.now()` for a step timing. Write all turn attributes before `endRequest()`.

### 3. Consistent span attributes

Rule: every attribute name follows one schema, and every product uses the same names for the same facts. Attributes carry counts and identifiers in place of free content where possible, and values have a fixed length limit.

In the example: `schemas.ts` declares the `lookup` tool and the `answer` model call. The handles `fw.tool('lookup', LOOKUP_SCHEMA)` and `fw.model('answer', ANSWER_SCHEMA)` write `app.tool.lookup.*` and `app.model.answer.*`. The tool writes `result_count`, not the results. States are enums.

When you extend it: give each new tool, model call or sub-agent a schema in `schemas.ts`, and write through its handle. Prefer `count` and `enum` to free text. Set `maxLength` on each string. Never rename an attribute after data exists under it: use `renamedFrom` (see the root `AGENTS.md`).

### 4. Check the logging works first

Rule: at start-up, the product proves that telemetry reaches the backend before it serves traffic. A missing provider fails that check.

In the example: `main.ts` registers telemetry before `init()`. It reads the self-check report and refuses to start when the check fails. `telemetry.ts` raises the span attribute limit to 1024, because the SDK default of 128 drops keys with no error.

When you extend it: keep the order in `main.ts`. When you change the backend, keep the attribute limit and confirm the `flywheel.startup` span arrives in the backend.

### 5. Each evaluator lists the data it needs

Rule: each evaluator declares the fields it `requires` and the values it `expects`. A check compares those lists with the fields the product writes.

In the example: `schemas.ts` is the module that the manifest command reads. `npm run example:manifest` writes `instrumentation-manifest.json`, which lists every attribute name the agent can write on a turn.

When you extend it: add every new attribute to `schemas.ts`, then write the manifest again. In a product that the Flywheel evaluates, commit the manifest, map each evaluator field to its attribute names in the `instrumentation:` section of `flywheel.yaml`, and run `flywheel check`.

### 6. Feedback is attached to the turn

Rule: each piece of user feedback joins the trace of the turn it rates, so a reader finds both in one place.

In the example: `/chat` returns `turn.ref` with the answer. `/feedback` takes that ref and calls `fw.feedback()`. The feedback span is a child of the turn span.

When you extend it: return the turn ref from every route that runs a turn. Send each feedback kind (rating, comment, correction) through `feedback()` with that ref.

### 7. Agents read the record and act

Rule: agents read the turn records, find faults and propose changes. A person approves every change.

In the example: none. The Flywheel owns this practice. Principles 1 to 6 give it the data it reads.

## Build on the example

| Change | Steps |
|---|---|
| Add a tool | Define it with `tool()` from `ai`. Run its body in `fw.timed()`. Add its schema to `schemas.ts` and write through `fw.tool(name, schema)`. Write the manifest again. Extend `test/example.test.ts` |
| Add a model call or a sub-agent | Run it inside the same `turn()`. Pass `fw.aiSdkTelemetry()` to the AI SDK call. Add a `model` or `agent` schema |
| Use a real model | Set `EXAMPLE_OPENAI_MODEL` and `OPENAI_API_KEY`, or change `model.ts` |
| Use another backend | Change `telemetry.ts` only. Azure Monitor: `useAzureMonitor()` and `init({ azureCustomEvents: true })`. Langfuse: add `LangfuseSpanProcessor`. Langfuse ingests spans only. See "Backends" in the root `AGENTS.md` |
| Use another agent framework | Keep `turn()` as the root. Write the model and tool steps as spans under it, through `fw.timed()` and the node handles. `recordStreamPart` reads AI SDK 5 stream parts only |
| Add a feedback kind | Add a route that calls `fw.feedback()` with the turn ref and its own `name` and `kind` |

## Rules

- Register the providers before any product code runs. Call `init()` once, then `flywheel()` everywhere else.
- Run every step of a turn inside `turn()`, so its spans share one trace.
- Write each attribute through a schema handle or `turn.record`, so the manifest lists it.
- Pass an opaque id to `user()` and `session()`, such as a random or hashed value. Do not write a name, an email address or a secret in any attribute.
- After each change, run `npm run build`, `npm run typecheck` and `npm test`. The example test must pass.

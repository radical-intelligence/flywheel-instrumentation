# AGENTS.md: the example agent on Langfuse

This file is for an AI agent that sends an instrumented agent's telemetry to Langfuse. It maps each of the seven practices to Langfuse: where the data lands and how to see it.

The agent is the shared blueprint in `examples/agent/` (see `examples/agent/AGENTS.md`). This folder holds only what Langfuse changes:

| File | Responsibility |
|---|---|
| `telemetry.ts` | Registers a tracer provider with `LangfuseSpanProcessor` from `@langfuse/otel`. Registers no logger provider |
| `main.ts` | Calls `run()` from `examples/agent/main.ts` with the Langfuse registration and the default `init()` options |

The attribute names are the same as on every other backend. Do not rename an attribute for Langfuse.

## Run it

| Variable | Required | Meaning |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | Yes | The project public key |
| `LANGFUSE_SECRET_KEY` | Yes | The project secret key |
| `LANGFUSE_BASE_URL` | No | The Langfuse host. The default is Langfuse Cloud. The processor also reads the old name `LANGFUSE_BASEURL` |

Run `npm run build`, then `npm run example:langfuse`. Without the two keys, the example prints the missing names and exits with code 1. `test/backends.test.ts` checks this.

## Setup rules

- Export every span. The default filter of `LangfuseSpanProcessor` keeps a span only when it has a `gen_ai.*` attribute or comes from a known LLM library. It drops `flywheel.startup` and the `feedback()` spans. `telemetry.ts` sets `shouldExportSpan` to keep every span. Source: `src/span-filter.ts` in `@langfuse/otel` 5.10.1.
- Raise the span attribute count limit to 1024. `telemetry.ts` sets it on the tracer provider.
- Register a context manager, so the turn span is the parent of the spans inside it.
- Do not set `azureCustomEvents`. Langfuse ingests no OpenTelemetry log records.

## Where each practice lands

Each row ran against a Langfuse Cloud project on 2026-10-15, with one chat and one feedback, and was read back through the public API v2. A row marked unverified did not.

| Practice | Where it lands in Langfuse | How to see it |
|---|---|---|
| 1. One record per turn | The turn span is the root observation of the trace, of type `AGENT`. The AI SDK spans are its children: `ai.streamText` as a `SPAN`, each `ai.streamText.doStream` as a `GENERATION` with token usage, and `ai.toolCall` as a `TOOL` named after the tool | The trace view. The API: `GET /api/public/v2/observations?traceId=<traceId>` |
| 2. One clock per request | `app.timeline.*` and `app.turn.timing.*` are in the turn observation metadata. The observation start and end times come from the span | The metadata of the turn observation |
| 3. Consistent span attributes | Each span attribute is a metadata key with the prefix `attributes.`, for example `attributes.app.tool.lookup.status`. The metadata also holds `scope.*` and `resourceAttributes.*` keys. The turn observation has the conversation id as its `sessionId`. The turn span carries both `session.id` and `gen_ai.conversation.id`, so the run does not show which one Langfuse reads | The metadata panel, or `fields=core,metadata` on the observations API |
| 4. Check the logging works first | Each `flywheel.startup` span is a root observation of type `SPAN` in its own trace. Its `flywheel.*` attributes are in its metadata | The start-up query under practice 4 in the root `AGENTS.md` |
| 5. Each evaluator lists the data it needs | Not in Langfuse. The manifest is a file. The names in it are the span attribute names, so a reader of Langfuse adds the prefix `attributes.` | `npm run example:manifest` |
| 6. Feedback is attached to the turn | The `feedback()` span is an observation of type `SPAN`, named by its event name, on the turn's trace. Its `parentObservationId` is the turn observation. The `feedback.*` attributes are in its metadata. It is not a Langfuse score | The trace view, under the turn observation |
| 7. Agents read the record and act | Not in this package. The Flywheel reads the observations through the public API | See the Flywheel repository |

## Gaps

- No log records. `metadata()` events and the `azureCustomEvents` records do not arrive. Use `feedback()`, which writes a span.
- Feedback is not a score. A Langfuse score or annotation view does not show it. Unverified: no change in this package or the example writes a Langfuse score.
- The turn observation has no `input` or `output`. The query and the answer are in its metadata as `attributes.app.turn.query` and `attributes.app.turn.answer`. The AI SDK observations do have `input` and `output`.
- `userId` stays empty in the run above, because the example does not call `user()`. Unverified: whether Langfuse fills `userId` from `enduser.id` (see practice 4 in the root `AGENTS.md`).
- Feedback with no turn ref joins a per-session trace with no root observation. Unverified: how Langfuse shows it.
- Unverified: the Langfuse limit on one metadata value. The self-check uses the Azure value of 8192 bytes by default (`init({ valueSizeLimit })`).

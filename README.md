# flywheel-instrumentation

`@radical-intelligence/flywheel-instrumentation` writes a product's telemetry onto OpenTelemetry spans and log records. The Flywheel reads that telemetry to evaluate each turn and to propose changes.

The package implements the blueprint [Observability for agentic systems](https://claude.ai/code/artifact/bb1b8171-227c-4d95-8b1c-42fdd260426c). The blueprint has seven practices. [AGENTS.md](AGENTS.md) gives the rule, the API, the status and the tests for each one.

## Install

```bash
npm i github:radical-intelligence/flywheel-instrumentation#v1.0.0
npm i @opentelemetry/api @opentelemetry/api-logs
```

The install builds `dist/`. The two OpenTelemetry packages are peer dependencies. Express and the AI SDK are optional peer dependencies, for the `./express` and `./ai-sdk` subpaths.

## Usage

1. Register an OpenTelemetry tracer provider and logger provider before the product code runs.
2. Call `init({ schemas })` once. It returns the live instance and runs a start-up self-check.
3. Everywhere else, call `flywheel()`. Wrap each turn in `turn()`, write node attributes with `tool()`, `model()` and `agent()`, and send user feedback with `feedback()`.
4. Write the manifest for the Flywheel with the `flywheel-instrumentation-manifest` command.

AGENTS.md has the full guide. The public API is in `src/index.ts`, with the types in `src/types.ts`. The subpaths are in `src/express.ts`, `src/ai-sdk.ts` and `src/manifest.ts`.

## Blueprint agent

`examples/agent/` is the blueprint for an instrumented agent. Start a new agent from it, or copy its pattern into an existing product. It is a small Express agent that uses the package, with practices 1 to 6 in code. It runs with a mock model and a console exporter, so it needs no API key and no network. Each file explains its part in its header comment. Start with `examples/agent/AGENTS.md`. It maps each practice to the code, and says how to extend the agent without breaking one.

```bash
npm run build
npm run example            # serves POST /chat and POST /feedback on port 3000
npm run example:manifest   # writes examples/agent/instrumentation-manifest.json
```

`test/example.test.ts` boots the example and checks the spans it exports.

The same agent runs on two backends. Each folder holds only the telemetry registration, an entry point and an `AGENTS.md` that maps the practices to that backend:

| Folder | Backend | Command | Environment |
|---|---|---|---|
| `examples/azure-appi/` | Azure Monitor (Application Insights) | `npm run example:azure` | `APPLICATIONINSIGHTS_CONNECTION_STRING` |
| `examples/langfuse/` | Langfuse | `npm run example:langfuse` | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, optional `LANGFUSE_BASE_URL` |

Each stops with exit code 1 when a required variable is missing.

## Backends

The seven practices are the target on every backend. FLS sends its telemetry to Application Insights today. Langfuse, Arize and other OpenTelemetry backends implement the same practices, with the same attribute names, through this package. Only the telemetry registration changes.

The package uses only the OpenTelemetry API, so the product picks the exporter. AGENTS.md documents two backends:

- Azure Monitor (Application Insights), through `@azure/monitor-opentelemetry`. See `examples/azure-appi/`.
- Langfuse, through `LangfuseSpanProcessor` from `@langfuse/otel`. Langfuse ingests spans only, not log records. See `examples/langfuse/`.

To add a backend, for example Arize Phoenix through an OTLP exporter, copy `examples/langfuse/`, change its `telemetry.ts`, write its `AGENTS.md` practice map and add an `example:<backend>` script. "Add a backend" in AGENTS.md has the steps.

## Tests

The contract suite in `test/contract.ts` runs each case against a real OpenTelemetry SDK (`test/sdk.ts`).

The conformance fixtures in `conformance/` are the language-neutral specification of the package. A port to another language passes when its runner writes the same output for every scenario. See `conformance/AGENTS.md`.

```bash
npm ci
npm run build
npm run typecheck
npm test
```

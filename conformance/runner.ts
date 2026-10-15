/**
 * The conformance runner for the TypeScript package.
 *
 *   npm run conformance          compare each scenario with its expected output
 *   npm run conformance:update   write the expected output from this package
 *
 * Each scenario runs in its own process (`execute.ts`). The runner checks
 * each scenario against `scenario.schema.json` and each output against
 * `output.schema.json`, then compares the output with `expected/<name>.json`
 * byte for byte. A port in another language runs the same scenarios with
 * its own runner, and must write the same bytes. See `AGENTS.md` here.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'

const dir = fileURLToPath(new URL('.', import.meta.url))
const scenariosDir = join(dir, 'scenarios')
const expectedDir = join(dir, 'expected')
const update = process.argv.includes('--update')

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true })
const validScenario = ajv.compile(JSON.parse(readFileSync(join(dir, 'scenario.schema.json'), 'utf8')))
const validOutput = ajv.compile(JSON.parse(readFileSync(join(dir, 'output.schema.json'), 'utf8')))

/** The environment of a scenario process: this one, with no OpenTelemetry variable. */
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OTEL_')))

function execute(file: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(dir, 'execute.ts'), file], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d })
    child.stderr.on('data', (d: Buffer) => { stderr += d })
    child.on('error', reject)
    child.on('close', code => resolve({ stdout, stderr, code }))
  })
}

/** The first line that differs, with three lines of context on each side. */
function firstDifference(expected: string, actual: string): string {
  const e = expected.split('\n')
  const a = actual.split('\n')
  let i = 0
  while (i < e.length && i < a.length && e[i] === a[i]) i++
  const from = Math.max(0, i - 3)
  const lines = [`first difference at line ${i + 1}:`]
  for (let j = from; j < i; j++) lines.push(`    ${e[j]}`)
  for (let j = i; j < Math.min(e.length, i + 4); j++) lines.push(`  - ${e[j]}`)
  for (let j = i; j < Math.min(a.length, i + 4); j++) lines.push(`  + ${a[j]}`)
  return lines.join('\n')
}

async function check(name: string): Promise<string | undefined> {
  const file = join(scenariosDir, `${name}.json`)
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }
  if (!validScenario(scenario)) return `invalid scenario: ${ajv.errorsText(validScenario.errors)}`
  if (scenario.name !== name) return `the scenario name ${String(scenario.name)} is not the file name`

  const run = await execute(file)
  if (run.code !== 0) return `the scenario process exited with ${run.code}:\n${run.stderr}`
  if (!validOutput(JSON.parse(run.stdout))) return `invalid output: ${ajv.errorsText(validOutput.errors)}`

  const target = join(expectedDir, `${name}.json`)
  if (update) {
    writeFileSync(target, run.stdout)
    return undefined
  }
  if (!existsSync(target)) return `no expected output: run npm run conformance:update`
  const expected = readFileSync(target, 'utf8')
  return expected === run.stdout ? undefined : firstDifference(expected, run.stdout)
}

const names = readdirSync(scenariosDir).filter(f => f.endsWith('.json')).map(f => basename(f, '.json')).sort()
const failures: string[] = []
for (const f of readdirSync(expectedDir).filter(f => f.endsWith('.json'))) {
  if (!names.includes(basename(f, '.json'))) failures.push(`expected/${f}: no scenario has this name`)
}

// A few processes at a time: each one loads tsx and the SDK.
const queue = [...names]
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const failure = await check(name)
    if (failure) failures.push(`${name}: ${failure}`)
  }
}))

if (failures.length > 0) {
  for (const f of failures.sort()) console.error(`not ok ${f}\n`)
  console.error(`conformance: ${failures.length} of ${names.length} scenarios failed`)
  process.exit(1)
}
console.log(`conformance: ${names.length} scenarios ${update ? 'written' : 'pass'}`)

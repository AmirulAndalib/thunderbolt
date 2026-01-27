#!/usr/bin/env bun
/**
 * stress test matrix runner
 *
 * runs stress tests across multiple models and scenarios.
 * results get saved to json files for comparison.
 */

import { join } from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// types
// ─────────────────────────────────────────────────────────────────────────────

type Scenario = {
  name: string
  clients: number
  duration: number
  contextSize: number
  maxTokens: number
  prompt: string | null
  rampUpTime: number
}

type MatrixConfig = {
  baseUrl: string
  apiKey: string | null
  models: string[]
  scenarios: Scenario[]
  outputDir: string
  direct: boolean
}

type RequestResult = {
  id: number
  ttft: number | null
  totalTime: number | null
  tokensReceived: number
  error: string | null
  status: 'pending' | 'streaming' | 'completed' | 'error'
}

type ScenarioResult = {
  timestamp: string
  model: string
  scenario: string
  config: Scenario
  summary: {
    totalRequests: number
    completed: number
    failed: number
    aborted: number
    successRate: string
    avgTtft: number
    p50Ttft: number
    p95Ttft: number
    p99Ttft: number
    avgTotalTime: number
    tokensPerSecond: number
    totalTokens: number
  }
  errors: Record<string, number>
}

// ─────────────────────────────────────────────────────────────────────────────
// constants
// ─────────────────────────────────────────────────────────────────────────────

const MODELS = ['gpt-oss-120b', 'mistral-medium-3.1', 'mistral-large-3', 'sonnet-4.5']

// when hitting inference providers directly, we need the internal model names
const MODEL_INTERNAL_NAMES: Record<string, string> = {
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'mistral-medium-3.1': 'mistral-medium-2508',
  'mistral-large-3': 'mistral-large-2512',
  'sonnet-4.5': 'claude-sonnet-4-5',
}

const DEFAULT_SCENARIOS: Scenario[] = [
  {
    name: 'light',
    clients: 3,
    duration: 30,
    contextSize: 500,
    maxTokens: 128,
    prompt: 'short',
    rampUpTime: 3,
  },
  {
    name: 'standard',
    clients: 5,
    duration: 60,
    contextSize: 1000,
    maxTokens: 256,
    prompt: 'medium',
    rampUpTime: 5,
  },
  {
    name: 'heavy',
    clients: 10,
    duration: 60,
    contextSize: 5000,
    maxTokens: 1000,
    prompt: 'long',
    rampUpTime: 5,
  },
  {
    name: 'reasoning',
    clients: 5,
    duration: 60,
    contextSize: 1000,
    maxTokens: 1000,
    prompt: 'reasoning',
    rampUpTime: 5,
  },
  {
    name: 'code-gen',
    clients: 5,
    duration: 60,
    contextSize: 2000,
    maxTokens: 1500,
    prompt: 'code',
    rampUpTime: 5,
  },
]

// defaults to localhost - use --url or STRESS_TEST_URL to hit the real inference provider
const resolveBaseUrl = () => process.env.STRESS_TEST_URL || 'http://localhost:8000/v1'
const resolveApiKey = () => process.env.THUNDERBOLT_INFERENCE_API_KEY || null

const DEFAULT_CONFIG: MatrixConfig = {
  baseUrl: resolveBaseUrl(),
  apiKey: resolveApiKey(),
  models: MODELS,
  scenarios: DEFAULT_SCENARIOS,
  outputDir: './stress-test-results',
  direct: false,
}

const PROMPT_PRESETS: Record<string, string> = {
  short: 'Say hello in one sentence.',
  medium: 'Explain how a car engine works in 2-3 paragraphs.',
  long: 'Write a detailed essay about the history of computing, covering major milestones from the 1940s to present day.',
  code: 'Write a TypeScript function that implements a binary search tree with insert, delete, and search operations.',
  reasoning: 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Think step by step.',
}

// ─────────────────────────────────────────────────────────────────────────────
// terminal helpers
// ─────────────────────────────────────────────────────────────────────────────

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

const formatMs = (ms: number): string => {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

const percentile = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

// ─────────────────────────────────────────────────────────────────────────────
// test runner (simplified version of stress-test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const generatePrompt = (scenario: Scenario): string => {
  if (scenario.prompt && PROMPT_PRESETS[scenario.prompt]) {
    return PROMPT_PRESETS[scenario.prompt]
  }
  if (scenario.prompt) {
    return scenario.prompt
  }
  // generate filler to hit target context size
  const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
  const targetChars = scenario.contextSize * 4
  const fillerRepeats = Math.max(1, Math.floor(targetChars / filler.length))
  return 'Respond briefly. Context: ' + filler.repeat(fillerRepeats)
}

const makeRequest = async (
  baseUrl: string,
  apiKey: string | null,
  model: string,
  scenario: Scenario,
  signal: AbortSignal,
  direct: boolean,
): Promise<RequestResult> => {
  const startTime = Date.now()
  const prompt = generatePrompt(scenario)

  // use internal model name when hitting provider directly
  const modelName = direct ? (MODEL_INTERNAL_NAMES[model] || model) : model

  const result: RequestResult = {
    id: 0,
    ttft: null,
    totalTime: null,
    tokensReceived: 0,
    error: null,
    status: 'pending',
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        max_tokens: scenario.maxTokens,
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    result.status = 'streaming'
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let firstTokenReceived = false

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n').filter((line) => line.startsWith('data: '))

      for (const line of lines) {
        const data = line.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          const content = parsed.choices?.[0]?.delta?.content

          if (content && !firstTokenReceived) {
            firstTokenReceived = true
            result.ttft = Date.now() - startTime
          }

          if (content) {
            result.tokensReceived += Math.ceil(content.length / 4)
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }

    result.totalTime = Date.now() - startTime
    result.status = 'completed'
  } catch (error) {
    result.status = 'error'
    result.error = error instanceof Error ? error.message : String(error)
    result.totalTime = Date.now() - startTime
  }

  return result
}

const runScenario = async (
  baseUrl: string,
  apiKey: string | null,
  model: string,
  scenario: Scenario,
  onProgress: (completed: number, total: number, active: number) => void,
  direct: boolean,
): Promise<ScenarioResult> => {
  const results: RequestResult[] = []
  const controller = new AbortController()
  const startTime = Date.now()

  // stop after duration
  const stopTimeout = setTimeout(() => {
    controller.abort()
  }, scenario.duration * 1000)

  let totalStarted = 0
  let activeRequests = 0

  const progressInterval = setInterval(() => {
    const completed = results.filter((r) => r.status === 'completed' || r.status === 'error').length
    onProgress(completed, totalStarted, activeRequests)
  }, 500)

  // spawn clients with ramp-up delay between each
  const clientDelay = (scenario.rampUpTime * 1000) / scenario.clients
  const clientPromises: Promise<void>[] = []

  for (let i = 0; i < scenario.clients; i++) {
    const clientPromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        while (!controller.signal.aborted) {
          totalStarted++
          activeRequests++

          const result = await makeRequest(baseUrl, apiKey, model, scenario, controller.signal, direct)
          results.push(result)
          activeRequests--

          await new Promise((r) => setTimeout(r, 100))
        }
        resolve()
      }, i * clientDelay)
    })
    clientPromises.push(clientPromise)
  }

  await Promise.all(clientPromises)

  clearTimeout(stopTimeout)
  clearInterval(progressInterval)

  // calculate stats (aborted requests are excluded from success rate - they're just cleanup)
  const elapsed = (Date.now() - startTime) / 1000
  const completed = results.filter((r) => r.status === 'completed')
  const failed = results.filter((r) => r.status === 'error' && r.error !== 'Aborted')
  const aborted = results.filter((r) => r.status === 'error' && r.error === 'Aborted')

  const ttfts = completed.map((r) => r.ttft).filter((t): t is number => t !== null)
  const totalTimes = completed.map((r) => r.totalTime).filter((t): t is number => t !== null)
  const totalTokens = results.reduce((sum, r) => sum + r.tokensReceived, 0)

  const errorCounts: Record<string, number> = {}
  for (const r of failed) {
    const key = r.error || 'Unknown'
    errorCounts[key] = (errorCounts[key] || 0) + 1
  }

  const relevantRequests = completed.length + failed.length
  const successRate = relevantRequests > 0 ? ((completed.length / relevantRequests) * 100).toFixed(2) + '%' : '0%'

  return {
    timestamp: new Date().toISOString(),
    model,
    scenario: scenario.name,
    config: scenario,
    summary: {
      totalRequests: results.length,
      completed: completed.length,
      failed: failed.length,
      aborted: aborted.length,
      successRate,
      avgTtft: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0,
      p50Ttft: percentile(ttfts, 50),
      p95Ttft: percentile(ttfts, 95),
      p99Ttft: percentile(ttfts, 99),
      avgTotalTime: totalTimes.length > 0 ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : 0,
      tokensPerSecond: elapsed > 0 ? totalTokens / elapsed : 0,
      totalTokens,
    },
    errors: errorCounts,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// file i/o
// ─────────────────────────────────────────────────────────────────────────────

const ensureDir = async (dir: string) => {
  try {
    await Bun.write(join(dir, '.gitkeep'), '')
  } catch {
    // dir probably already exists
  }
}

const appendResult = async (outputDir: string, model: string, result: ScenarioResult) => {
  const filePath = join(outputDir, `${model}-results.json`)

  let existing: ScenarioResult[] = []
  try {
    const file = Bun.file(filePath)
    if (await file.exists()) {
      existing = await file.json()
    }
  } catch {
    // file doesn't exist or is invalid, start fresh
  }

  existing.push(result)
  await Bun.write(filePath, JSON.stringify(existing, null, 2))
}

const writeSummary = async (outputDir: string, allResults: ScenarioResult[]) => {
  const summary = {
    generatedAt: new Date().toISOString(),
    totalTests: allResults.length,
    byModel: {} as Record<string, { scenarios: number; avgSuccessRate: number; avgTtft: number }>,
    byScenario: {} as Record<string, { models: number; avgSuccessRate: number; avgTtft: number }>,
    results: allResults.map((r) => ({
      model: r.model,
      scenario: r.scenario,
      successRate: r.summary.successRate,
      avgTtft: formatMs(r.summary.avgTtft),
      p95Ttft: formatMs(r.summary.p95Ttft),
      tokensPerSec: r.summary.tokensPerSecond.toFixed(1),
    })),
  }

  // aggregate by model
  for (const result of allResults) {
    if (!summary.byModel[result.model]) {
      summary.byModel[result.model] = { scenarios: 0, avgSuccessRate: 0, avgTtft: 0 }
    }
    const m = summary.byModel[result.model]
    const rate = parseFloat(result.summary.successRate)
    m.avgSuccessRate = (m.avgSuccessRate * m.scenarios + rate) / (m.scenarios + 1)
    m.avgTtft = (m.avgTtft * m.scenarios + result.summary.avgTtft) / (m.scenarios + 1)
    m.scenarios++
  }

  // aggregate by scenario
  for (const result of allResults) {
    if (!summary.byScenario[result.scenario]) {
      summary.byScenario[result.scenario] = { models: 0, avgSuccessRate: 0, avgTtft: 0 }
    }
    const s = summary.byScenario[result.scenario]
    const rate = parseFloat(result.summary.successRate)
    s.avgSuccessRate = (s.avgSuccessRate * s.models + rate) / (s.models + 1)
    s.avgTtft = (s.avgTtft * s.models + result.summary.avgTtft) / (s.models + 1)
    s.models++
  }

  await Bun.write(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────────
// cli
// ─────────────────────────────────────────────────────────────────────────────

const parseArgs = async (): Promise<MatrixConfig> => {
  const config = { ...DEFAULT_CONFIG }

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]

    if (arg === '--help' || arg === '-h') {
      console.log(`
${BOLD}Stress Test Matrix Runner${RESET}

Runs stress tests across multiple models and scenarios.

${BOLD}Usage:${RESET}
  bun run stress-test:matrix [options]

${BOLD}Options:${RESET}
  --url <url>           Base URL (default: from env or localhost:8000)
  --api-key <key>       API key for Authorization header (default: from env)
  --models <list>       Comma-separated list of models (default: all)
  --scenarios <list>    Comma-separated scenario names (default: all)
  --config <file>       Load config from JSON file
  --output-dir <dir>    Output directory (default: ${DEFAULT_CONFIG.outputDir})
  --direct              Hit inference provider directly (uses internal model names)
  -h, --help            Show this help

${BOLD}Available models:${RESET}
  ${MODELS.join(', ')}

${BOLD}Default scenarios:${RESET}
  light      3 clients, 128 max tokens, short prompts
  standard   5 clients, 256 max tokens, medium prompts
  heavy      10 clients, 1K max tokens, long prompts
  reasoning  5 clients, 1K max tokens, step-by-step thinking
  code-gen   5 clients, 1.5K max tokens, code generation

${BOLD}Examples:${RESET}
  bun run stress-test:matrix
  bun run stress-test:matrix --models gpt-oss-120b,sonnet-4.5
  bun run stress-test:matrix --scenarios light,standard
  bun run stress-test:matrix --output-dir ./my-results

${BOLD}Output:${RESET}
  results are saved to:
    <output-dir>/<model>-results.json   per-model results (appended each run)
    <output-dir>/summary.json           cross-model comparison

${BOLD}Glossary:${RESET}
  TTFT          time to first token - how long until the model starts responding
  p50/p95/p99   percentiles - p95 means 95% of requests were faster than this
  tokens/sec    throughput - total tokens generated per second across all clients
  completed     requests that finished successfully
  failed        requests that errored out (not counting aborted)
  aborted       requests that were in-flight when the test ended (not failures)
  successRate   completed / (completed + failed) - excludes aborted

${BOLD}Environment:${RESET}
  STRESS_TEST_URL               override the base URL (default: localhost:8000)
  THUNDERBOLT_INFERENCE_API_KEY API key for the inference provider
`)
      process.exit(0)
    }

    if (arg === '--url') config.baseUrl = process.argv[++i]
    if (arg === '--api-key') config.apiKey = process.argv[++i]
    if (arg === '--output-dir') config.outputDir = process.argv[++i]
    if (arg === '--models') config.models = process.argv[++i].split(',')
    if (arg === '--scenarios') {
      const names = process.argv[++i].split(',')
      config.scenarios = DEFAULT_SCENARIOS.filter((s) => names.includes(s.name))
    }
    if (arg === '--config') {
      const configFile = await Bun.file(process.argv[++i]).json()
      Object.assign(config, configFile)
    }
    if (arg === '--direct') config.direct = true
  }

  return config
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  const config = await parseArgs()

  const directLabel = config.direct ? ` ${YELLOW}[DIRECT]${RESET}` : ''
  console.log(`\n${BOLD}${CYAN}⚡ Stress Test Matrix${RESET}${directLabel}`)
  const authLabel = config.apiKey ? ` ${DIM}(authenticated)${RESET}` : ''
  console.log(`${DIM}${config.baseUrl}${RESET}${authLabel}`)
  console.log(`${DIM}Models: ${config.models.join(', ')}${RESET}`)
  console.log(`${DIM}Scenarios: ${config.scenarios.map((s) => s.name).join(', ')}${RESET}`)
  console.log(`${DIM}Output: ${config.outputDir}${RESET}\n`)

  await ensureDir(config.outputDir)

  const totalTests = config.models.length * config.scenarios.length
  let currentTest = 0
  const allResults: ScenarioResult[] = []

  for (const model of config.models) {
    for (const scenario of config.scenarios) {
      currentTest++
      const prefix = `[${currentTest}/${totalTests}]`

      console.log(`${prefix} ${CYAN}${model}${RESET} × ${YELLOW}${scenario.name}${RESET}`)
      console.log(`    ${DIM}${scenario.clients} clients, ${scenario.duration}s, ${scenario.maxTokens} max tokens${RESET}`)

      const result = await runScenario(config.baseUrl, config.apiKey, model, scenario, (completed, total, active) => {
        process.stdout.write(`\r    ${DIM}Progress: ${completed}/${total} completed, ${active} active${RESET}    `)
      }, config.direct)

      process.stdout.write('\r' + ' '.repeat(60) + '\r')

      const successColor = parseFloat(result.summary.successRate) >= 95 ? GREEN : parseFloat(result.summary.successRate) >= 80 ? YELLOW : RED
      console.log(`    ${successColor}${result.summary.successRate} success${RESET}, TTFT: ${formatMs(result.summary.avgTtft)} avg / ${formatMs(result.summary.p95Ttft)} p95`)

      if (result.summary.aborted > 0) {
        console.log(`    ${DIM}${result.summary.aborted} aborted at test end${RESET}`)
      }

      if (Object.keys(result.errors).length > 0) {
        for (const [err, count] of Object.entries(result.errors)) {
          console.log(`    ${RED}${count}x ${err}${RESET}`)
        }
      }

      console.log('')

      await appendResult(config.outputDir, model, result)
      allResults.push(result)
    }
  }

  await writeSummary(config.outputDir, allResults)

  console.log(`${GREEN}✓${RESET} Matrix complete. Results saved to ${BOLD}${config.outputDir}/${RESET}`)
  console.log(`  • Per-model results: ${config.models.map((m) => `${m}-results.json`).join(', ')}`)
  console.log(`  • Summary: summary.json\n`)
}

main().catch(console.error)

#!/usr/bin/env bun
/**
 * stress test script
 *
 * hammers the inference api to see how it holds up under load.
 * run with --help to see all the options.
 */

// ─────────────────────────────────────────────────────────────────────────────
// types
// ─────────────────────────────────────────────────────────────────────────────

type RequestResult = {
  id: number
  model: string
  startTime: number
  ttft: number | null
  totalTime: number | null
  tokensReceived: number
  contextSize: number
  error: string | null
  status: 'pending' | 'streaming' | 'completed' | 'error'
}

type Config = {
  baseUrl: string
  apiKey: string | null
  clients: number
  duration: number
  model: string
  contextSize: number
  rampUpTime: number
  logErrors: string | null
  maxTokens: number
  prompt: string | null
  hardcore: boolean
  direct: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// constants
// ─────────────────────────────────────────────────────────────────────────────

const AVAILABLE_MODELS = ['gpt-oss-120b', 'mistral-medium-3.1', 'mistral-large-3', 'sonnet-4.5']

// when hitting inference providers directly, we need the internal model names
const MODEL_INTERNAL_NAMES: Record<string, string> = {
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'mistral-medium-3.1': 'mistral-medium-2508',
  'mistral-large-3': 'mistral-large-2512',
  'sonnet-4.5': 'claude-sonnet-4-5',
}

// defaults to localhost - use --url or STRESS_TEST_URL to hit the real inference provider
const resolveBaseUrl = () => process.env.STRESS_TEST_URL || 'http://localhost:8000/v1'
const resolveApiKey = () => process.env.THUNDERBOLT_INFERENCE_API_KEY || null

const DEFAULT_CONFIG: Config = {
  baseUrl: resolveBaseUrl(),
  apiKey: resolveApiKey(),
  clients: 5,
  duration: 30,
  model: 'gpt-oss-120b',
  contextSize: 1000,
  rampUpTime: 5,
  logErrors: null,
  maxTokens: 256,
  prompt: null,
  hardcore: false,
  direct: false,
}

const HARDCORE_CONFIG = {
  clients: 50,
  duration: 120,
  contextSize: 10000,
  maxTokens: 2000,
  rampUpTime: 2,
  prompt: 'long',
}

const PROMPT_PRESETS: Record<string, string> = {
  short: 'Say hello in one sentence.',
  medium: 'Explain how a car engine works in 2-3 paragraphs.',
  long: 'Write a detailed essay about the history of computing, covering major milestones from the 1940s to present day. Include sections on hardware evolution, software development, and the internet.',
  code: 'Write a TypeScript function that implements a binary search tree with insert, delete, and search operations. Include comprehensive comments explaining each method.',
  reasoning: 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Think through this step by step before answering.',
}

// ─────────────────────────────────────────────────────────────────────────────
// terminal helpers
// ─────────────────────────────────────────────────────────────────────────────

const CLEAR_LINE = '\x1b[2K'
const MOVE_UP = '\x1b[1A'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
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

const formatNumber = (n: number): string => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toFixed(0)
}

const percentile = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const generatePrompt = (config: Config): string => {
  // use custom prompt if provided, or check if it's a preset name
  if (config.prompt) {
    if (PROMPT_PRESETS[config.prompt]) {
      return PROMPT_PRESETS[config.prompt]
    }
    return config.prompt
  }

  // default: generate filler to hit target context size
  const basePrompt = 'Respond with a brief acknowledgment. Context: '
  const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
  const targetChars = config.contextSize * 4
  const fillerRepeats = Math.max(1, Math.floor((targetChars - basePrompt.length) / filler.length))
  return basePrompt + filler.repeat(fillerRepeats)
}

// ─────────────────────────────────────────────────────────────────────────────
// api client
// ─────────────────────────────────────────────────────────────────────────────

const makeStreamingRequest = async (
  config: Config,
  requestId: number,
  onUpdate: (result: Partial<RequestResult>) => void,
  signal: AbortSignal,
): Promise<RequestResult> => {
  const startTime = Date.now()
  const prompt = generatePrompt(config)

  // use internal model name when hitting provider directly
  const modelName = config.direct ? (MODEL_INTERNAL_NAMES[config.model] || config.model) : config.model

  const result: RequestResult = {
    id: requestId,
    model: config.model,
    startTime,
    ttft: null,
    totalTime: null,
    tokensReceived: 0,
    contextSize: config.contextSize,
    error: null,
    status: 'pending',
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        max_tokens: config.maxTokens,
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    result.status = 'streaming'
    onUpdate({ status: 'streaming' })

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
            onUpdate({ ttft: result.ttft })
          }

          if (content) {
            result.tokensReceived += Math.ceil(content.length / 4)
            onUpdate({ tokensReceived: result.tokensReceived })
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }

    result.totalTime = Date.now() - startTime
    result.status = 'completed'
    onUpdate({ totalTime: result.totalTime, status: 'completed' })
  } catch (error) {
    if (signal.aborted) {
      result.status = 'error'
      result.error = 'Aborted'
    } else {
      result.status = 'error'
      result.error = error instanceof Error ? error.message : String(error)
    }
    result.totalTime = Date.now() - startTime
    onUpdate({ status: 'error', error: result.error, totalTime: result.totalTime })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// stats calculation
// ─────────────────────────────────────────────────────────────────────────────

const calculateStats = (results: RequestResult[], elapsed: number) => {
  const completed = results.filter((r) => r.status === 'completed')
  const failed = results.filter((r) => r.status === 'error' && r.error !== 'Aborted')
  const aborted = results.filter((r) => r.status === 'error' && r.error === 'Aborted')
  const active = results.filter((r) => r.status === 'pending' || r.status === 'streaming')

  const ttfts = completed.map((r) => r.ttft).filter((t): t is number => t !== null)
  const totalTimes = completed.map((r) => r.totalTime).filter((t): t is number => t !== null)
  const totalTokens = results.reduce((sum, r) => sum + r.tokensReceived, 0)

  return {
    totalRequests: results.length,
    completedRequests: completed.length,
    failedRequests: failed.length,
    abortedRequests: aborted.length,
    activeRequests: active.length,
    avgTtft: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0,
    avgTotalTime: totalTimes.length > 0 ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : 0,
    p50Ttft: percentile(ttfts, 50),
    p95Ttft: percentile(ttfts, 95),
    p99Ttft: percentile(ttfts, 99),
    tokensPerSecond: elapsed > 0 ? totalTokens / elapsed : 0,
    totalTokens,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// display
// ─────────────────────────────────────────────────────────────────────────────

let displayLines = 0

const clearDisplay = () => {
  for (let i = 0; i < displayLines; i++) {
    process.stdout.write(MOVE_UP + CLEAR_LINE)
  }
  displayLines = 0
}

const printLine = (line: string) => {
  console.log(line)
  displayLines++
}

const renderDisplay = (config: Config, results: RequestResult[], elapsed: number, running: boolean) => {
  clearDisplay()

  const stats = calculateStats(results, elapsed)
  const progress = Math.min(100, (elapsed / config.duration) * 100)
  const progressBar = '█'.repeat(Math.floor(progress / 5)) + '░'.repeat(20 - Math.floor(progress / 5))

  printLine('')
  const hardcoreLabel = config.hardcore ? ` ${RED}[HARDCORE]${RESET}` : ''
  const directLabel = config.direct ? ` ${YELLOW}[DIRECT]${RESET}` : ''
  printLine(`${BOLD}${CYAN}⚡ Thunderbolt Stress Test${RESET}${hardcoreLabel}${directLabel}${running ? ` ${YELLOW}●${RESET}` : ` ${GREEN}✓${RESET}`}`)
  const authLabel = config.apiKey ? ` ${DIM}(authenticated)${RESET}` : ''
  printLine(`${DIM}${config.baseUrl}${RESET}${authLabel}`)
  printLine('')
  const promptLabel = config.prompt ? (PROMPT_PRESETS[config.prompt] ? config.prompt : 'custom') : 'filler'
  printLine(`${DIM}Model:${RESET} ${CYAN}${config.model}${RESET}  ${DIM}Clients:${RESET} ${config.clients}  ${DIM}Max tokens:${RESET} ${config.maxTokens}`)
  printLine(`${DIM}Prompt:${RESET} ${promptLabel}  ${DIM}Context:${RESET} ~${formatNumber(config.contextSize)} tokens`)
  printLine('')
  printLine(`${DIM}Progress:${RESET} [${progressBar}] ${formatMs(elapsed * 1000)} / ${formatMs(config.duration * 1000)}`)
  printLine('')
  printLine(`${BOLD}── Requests ──${RESET}`)
  printLine(`  Total:     ${stats.totalRequests}`)
  printLine(`  Completed: ${GREEN}${stats.completedRequests}${RESET}`)
  printLine(`  Active:    ${YELLOW}${stats.activeRequests}${RESET}`)
  printLine(`  Failed:    ${stats.failedRequests > 0 ? RED : ''}${stats.failedRequests}${RESET}`)
  if (stats.abortedRequests > 0) {
    printLine(`  ${DIM}Aborted:   ${stats.abortedRequests} (at test end)${RESET}`)
  }
  printLine('')
  printLine(`${BOLD}── Latency ──${RESET}`)
  const ttftColor = stats.avgTtft < 500 ? GREEN : stats.avgTtft < 2000 ? YELLOW : RED
  printLine(`  TTFT (avg):      ${ttftColor}${formatMs(stats.avgTtft)}${RESET}`)
  printLine(`  TTFT (p50/p95):  ${DIM}${formatMs(stats.p50Ttft)} / ${formatMs(stats.p95Ttft)}${RESET}`)
  printLine(`  Total (avg):     ${formatMs(stats.avgTotalTime)}`)
  printLine('')
  printLine(`${BOLD}── Throughput ──${RESET}`)
  printLine(`  Tokens/sec:  ${CYAN}${formatNumber(stats.tokensPerSecond)}${RESET}`)
  printLine(`  Total:       ${formatNumber(stats.totalTokens)} tokens`)

  // show errors - grouped by type, with details when test is complete
  const errors = results.filter((r) => r.status === 'error' && r.error !== 'Aborted')
  if (errors.length > 0) {
    printLine('')
    printLine(`${BOLD}${RED}── Errors ──${RESET}`)

    const errorCounts: Record<string, number> = {}
    for (const e of errors) {
      const key = e.error || 'Unknown'
      errorCounts[key] = (errorCounts[key] || 0) + 1
    }

    for (const errorType of Object.keys(errorCounts)) {
      printLine(`  ${RED}${errorCounts[errorType]}x${RESET} ${errorType}`)
    }

    // show recent error details when done
    if (!running && errors.length > 0) {
      printLine('')
      printLine(`${DIM}recent error details:${RESET}`)
      for (const e of errors.slice(-5)) {
        const elapsed = e.totalTime ? formatMs(e.totalTime) : 'N/A'
        printLine(`  ${DIM}#${e.id} @ ${elapsed}:${RESET} ${RED}${e.error}${RESET}`)
      }
    }
  }

  printLine('')
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

const parseArgs = (): Config => {
  const config = { ...DEFAULT_CONFIG }

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]

    if (arg === '--help' || arg === '-h') {
      console.log(`
${BOLD}Thunderbolt Stress Test${RESET}

${BOLD}Usage:${RESET}
  bun run stress-test [options]

${BOLD}Options:${RESET}
  --url <url>           Base URL (default: from env or localhost:8000)
  --api-key <key>       API key for Authorization header (default: from env)
  --clients <n>         Number of concurrent clients (default: ${DEFAULT_CONFIG.clients})
  --duration <seconds>  Test duration in seconds (default: ${DEFAULT_CONFIG.duration})
  --model <model>       Model to test (default: ${DEFAULT_CONFIG.model})
  --context-size <n>    Approximate input context size in tokens (default: ${DEFAULT_CONFIG.contextSize})
  --max-tokens <n>      Maximum output tokens per request (default: ${DEFAULT_CONFIG.maxTokens})
  --prompt <text>       Custom prompt or preset name (default: filler text)
  --ramp-up <seconds>   Time to ramp up all clients (default: ${DEFAULT_CONFIG.rampUpTime})
  --log-errors <file>   Write detailed error log to file (JSON format)
  --hardcore            Maximum stress mode (50 clients, 10K context, 2K output, 2min)
  --direct              Hit inference provider directly (uses internal model names)
  -h, --help            Show this help

${BOLD}Available models:${RESET}
  ${AVAILABLE_MODELS.join(', ')}

${BOLD}Prompt presets:${RESET}
  short      Brief response (~50 tokens)
  medium     2-3 paragraph explanation (~200 tokens)
  long       Detailed essay (~1000+ tokens)
  code       Write a TypeScript binary search tree
  reasoning  Math word problem with step-by-step thinking

${BOLD}Examples:${RESET}
  bun run stress-test
  bun run stress-test --clients 10 --duration 60
  bun run stress-test --prompt long --max-tokens 2000
  bun run stress-test --prompt "Write a haiku about coding"
  bun run stress-test --prompt reasoning --model sonnet-4.5
  bun run stress-test --model mistral-large-3 --context-size 50000
  bun run stress-test --hardcore --log-errors errors.json

${BOLD}Glossary:${RESET}
  TTFT          time to first token - how long until the model starts responding
  p50/p95/p99   percentiles - p95 means 95% of requests were faster than this
  tokens/sec    throughput - total tokens generated per second across all clients
  completed     requests that finished successfully
  failed        requests that errored out (not counting aborted)
  aborted       requests that were in-flight when the test ended (not failures)
  active        requests currently streaming

${BOLD}Environment:${RESET}
  STRESS_TEST_URL               override the base URL (default: localhost:8000)
  THUNDERBOLT_INFERENCE_API_KEY API key for the inference provider
`)
      process.exit(0)
    }

    if (arg === '--url') config.baseUrl = process.argv[++i]
    if (arg === '--api-key') config.apiKey = process.argv[++i]
    if (arg === '--clients') config.clients = parseInt(process.argv[++i], 10)
    if (arg === '--duration') config.duration = parseInt(process.argv[++i], 10)
    if (arg === '--model') config.model = process.argv[++i]
    if (arg === '--context-size') config.contextSize = parseInt(process.argv[++i], 10)
    if (arg === '--max-tokens') config.maxTokens = parseInt(process.argv[++i], 10)
    if (arg === '--prompt') config.prompt = process.argv[++i]
    if (arg === '--ramp-up') config.rampUpTime = parseInt(process.argv[++i], 10)
    if (arg === '--log-errors') config.logErrors = process.argv[++i]
    if (arg === '--hardcore') config.hardcore = true
    if (arg === '--direct') config.direct = true
  }

  // apply hardcore settings (can be overridden by explicit flags)
  if (config.hardcore) {
    // only apply defaults if not explicitly set
    if (config.clients === DEFAULT_CONFIG.clients) config.clients = HARDCORE_CONFIG.clients
    if (config.duration === DEFAULT_CONFIG.duration) config.duration = HARDCORE_CONFIG.duration
    if (config.contextSize === DEFAULT_CONFIG.contextSize) config.contextSize = HARDCORE_CONFIG.contextSize
    if (config.maxTokens === DEFAULT_CONFIG.maxTokens) config.maxTokens = HARDCORE_CONFIG.maxTokens
    if (config.rampUpTime === DEFAULT_CONFIG.rampUpTime) config.rampUpTime = HARDCORE_CONFIG.rampUpTime
    if (config.prompt === DEFAULT_CONFIG.prompt) config.prompt = HARDCORE_CONFIG.prompt
  }

  return config
}

const runStressTest = async (config: Config) => {
  const results: RequestResult[] = []
  const controller = new AbortController()
  const startTime = Date.now()
  let requestId = 0
  let running = true

  process.stdout.write(HIDE_CURSOR)

  // handle ctrl+c gracefully
  process.on('SIGINT', () => {
    controller.abort()
    running = false
    process.stdout.write(SHOW_CURSOR)
    console.log(`\n${YELLOW}stopped by user${RESET}`)
    process.exit(0)
  })

  renderDisplay(config, results, 0, true)

  // refresh display every 200ms
  const displayInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000
    renderDisplay(config, results, elapsed, running)
  }, 200)

  // stop after duration
  const stopTimeout = setTimeout(() => {
    controller.abort()
    running = false
  }, config.duration * 1000)

  // spawn clients with ramp-up delay between each
  const clientDelay = (config.rampUpTime * 1000) / config.clients
  const clientPromises: Promise<void>[] = []

  for (let i = 0; i < config.clients; i++) {
    const clientPromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        while (!controller.signal.aborted) {
          const id = ++requestId

          results.push({
            id,
            model: config.model,
            startTime: Date.now(),
            ttft: null,
            totalTime: null,
            tokensReceived: 0,
            contextSize: config.contextSize,
            error: null,
            status: 'pending',
          })

          await makeStreamingRequest(
            config,
            id,
            (update) => {
              const idx = results.findIndex((r) => r.id === id)
              if (idx !== -1) {
                Object.assign(results[idx], update)
              }
            },
            controller.signal,
          )

          // small delay between requests
          await new Promise((r) => setTimeout(r, 100))
        }
        resolve()
      }, i * clientDelay)
    })
    clientPromises.push(clientPromise)
  }

  await Promise.all(clientPromises)

  clearTimeout(stopTimeout)
  clearInterval(displayInterval)

  // final display
  const elapsed = (Date.now() - startTime) / 1000
  renderDisplay(config, results, elapsed, false)

  // write error log if requested
  if (config.logErrors) {
    // include all errors (aborted ones are separated in the summary)
    const allErrors = results.filter((r) => r.status === 'error')
    const realErrors = allErrors.filter((r) => r.error !== 'Aborted')
    const abortedCount = allErrors.length - realErrors.length
    const stats = calculateStats(results, elapsed)

    const errorLog = {
      timestamp: new Date().toISOString(),
      config: {
        baseUrl: config.baseUrl,
        model: config.model,
        clients: config.clients,
        duration: config.duration,
        contextSize: config.contextSize,
        maxTokens: config.maxTokens,
        prompt: config.prompt,
      },
      summary: {
        totalRequests: stats.totalRequests,
        completed: stats.completedRequests,
        failed: stats.failedRequests,
        abortedAtEnd: abortedCount,
        successRate:
          stats.completedRequests + stats.failedRequests > 0
            ? ((stats.completedRequests / (stats.completedRequests + stats.failedRequests)) * 100).toFixed(2) + '%'
            : '0%',
        avgTtft: stats.avgTtft,
        p95Ttft: stats.p95Ttft,
        tokensPerSecond: stats.tokensPerSecond,
      },
      errorsByType: allErrors.reduce((acc: Record<string, number>, e) => {
        const key = e.error || 'Unknown'
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {}),
      errors: allErrors.map((e) => ({
        id: e.id,
        error: e.error,
        totalTime: e.totalTime,
        timestamp: new Date(e.startTime).toISOString(),
      })),
    }

    await Bun.write(config.logErrors, JSON.stringify(errorLog, null, 2))
    console.log(`${DIM}Error log written to: ${config.logErrors}${RESET}`)
  }

  process.stdout.write(SHOW_CURSOR)
}

const config = parseArgs()
console.log(`${BOLD}${CYAN}⚡ Starting stress test...${RESET}\n`)
runStressTest(config)

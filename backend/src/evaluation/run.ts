#!/usr/bin/env bun
/**
 * Thunderbolt Evaluation Runner
 *
 * Standalone evaluation runner that:
 *   - Runs Promptfoo evaluations
 *   - Produces JSON artifacts with full metadata
 *   - Auto-detects LLM judge based on available API keys
 *
 * Output artifacts:
 *   - eval-results.json   (Promptfoo native format)
 *   - eval-summary.json   (Aggregate metrics + metadata)
 *
 * Usage:
 *   bun run eval --model gpt-oss-120b
 *   bun run eval --model mistral-medium-3.1 --no-cache
 */

import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// =============================================================================
// TYPES
// =============================================================================

type EvalMetadata = {
  runId: string
  timestamp: string
  git: {
    sha: string
    branch: string
    dirty: boolean
  }
  model: string
  judge: string
  datasetHash: string
  backendUrl: string
}

type EvalSummary = {
  metadata: EvalMetadata
  results: {
    total: number
    passed: number
    failed: number
    passRate: number
    avgScore: number
    duration: number
  }
  byCategory: Record<string, { passed: number; failed: number; avgScore: number }>
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SUPPORTED_MODELS = ['gpt-oss-120b', 'mistral-medium-3.1', 'mistral-large-3', 'sonnet-4.5'] as const

type SupportedModel = (typeof SUPPORTED_MODELS)[number]

const DEFAULT_MODEL: SupportedModel = 'mistral-medium-3.1'
const DEFAULT_BACKEND_URL = 'http://localhost:8000'
const EVAL_DIR = import.meta.dir

// =============================================================================
// GIT UTILITIES
// =============================================================================

const getGitInfo = (): EvalMetadata['git'] => {
  try {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' })
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' })
    const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf-8' })

    return {
      sha: sha.stdout?.trim() || 'unknown',
      branch: branch.stdout?.trim() || 'unknown',
      dirty: (status.stdout?.trim().length || 0) > 0,
    }
  } catch {
    return { sha: 'unknown', branch: 'unknown', dirty: false }
  }
}

const getDatasetHash = (): string => {
  try {
    const datasetPath = resolve(EVAL_DIR, 'dataset.yaml')
    const content = readFileSync(datasetPath, 'utf-8')
    return createHash('sha256').update(content).digest('hex').slice(0, 12)
  } catch {
    return 'unknown'
  }
}

const generateRunId = (git: EvalMetadata['git'], model: string): string => {
  const date = new Date().toISOString().split('T')[0]
  const input = `${git.sha}-${model}-${date}`
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

// =============================================================================
// JUDGE AUTO-DETECTION
// =============================================================================

const getJudgeModel = (): string => {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('🔍 Judge: Anthropic Claude Sonnet 4 (ANTHROPIC_API_KEY detected)')
    return 'anthropic:messages:claude-sonnet-4-20250514'
  }

  if (process.env.OPENAI_API_KEY) {
    console.log('🔍 Judge: OpenAI GPT-4o (OPENAI_API_KEY detected)')
    return 'openai:gpt-4o'
  }

  console.log('🔍 Judge: gpt-oss-120b (fallback, requires backend with Thunderbolt keys)')
  return 'gpt-oss-120b'
}

// =============================================================================
// CLI PARSING
// =============================================================================

type CliArgs = {
  model: SupportedModel
  backendUrl: string
  noCache: boolean
  verbose: boolean
  help: boolean
}

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2)
  const result: CliArgs = {
    model: DEFAULT_MODEL,
    backendUrl: process.env.BACKEND_URL || DEFAULT_BACKEND_URL,
    noCache: false,
    verbose: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--verbose' || arg === '-v') result.verbose = true
    else if (arg === '--no-cache') result.noCache = true
    else if (arg === '--model' || arg === '-m') {
      const val = args[++i]
      if (!val || !SUPPORTED_MODELS.includes(val as SupportedModel)) {
        console.error(`❌ Invalid model: ${val}`)
        console.error(`   Supported: ${SUPPORTED_MODELS.join(', ')}`)
        process.exit(1)
      }
      result.model = val as SupportedModel
    } else if (arg === '--backend-url') {
      result.backendUrl = args[++i]
    }
  }

  return result
}

const showHelp = () => {
  console.log(`
Thunderbolt Evaluation Runner

USAGE:
  bun run eval [OPTIONS]

OPTIONS:
  -m, --model <id>        Model to evaluate (default: ${DEFAULT_MODEL})
  --backend-url <url>     Backend URL (default: ${DEFAULT_BACKEND_URL})
  --no-cache              Force fresh API calls
  -v, --verbose           Verbose output
  -h, --help              Show this help

MODELS:
  ${SUPPORTED_MODELS.map((m) => `• ${m}`).join('\n  ')}

JUDGE AUTO-DETECTION:
  1. ANTHROPIC_API_KEY → anthropic:claude-sonnet-4-20250514
  2. OPENAI_API_KEY    → openai:gpt-4o
  3. Neither           → gpt-oss-120b (via backend)

OUTPUT:
  eval-results.json   Promptfoo native format
  eval-summary.json   Aggregate metrics + metadata

EXAMPLES:
  bun run eval --model gpt-oss-120b
  bun run eval --model mistral-medium-3.1 --no-cache
`)
}

// =============================================================================
// SUMMARY GENERATION
// =============================================================================

const generateSummary = (metadata: EvalMetadata, resultsPath: string, durationMs: number): EvalSummary | null => {
  if (!existsSync(resultsPath)) {
    console.error('❌ Results file not found')
    return null
  }

  try {
    const raw = JSON.parse(readFileSync(resultsPath, 'utf-8'))
    const results = raw.results?.results || raw.results || []

    let passed = 0
    let failed = 0
    let totalScore = 0
    const byCategory: Record<string, { passed: number; failed: number; scores: number[] }> = {}

    for (const r of results) {
      const score = r.gradingResult?.score ?? (r.gradingResult?.pass ? 1 : 0)
      const didPass = r.gradingResult?.pass ?? score >= 0.5

      if (didPass) passed++
      else failed++
      totalScore += score

      // Extract category from query (first word or "general")
      const query = r.prompt?.raw || r.vars?.query || ''
      const category = detectCategory(query)

      if (!byCategory[category]) {
        byCategory[category] = { passed: 0, failed: 0, scores: [] }
      }
      byCategory[category].scores.push(score)
      if (didPass) byCategory[category].passed++
      else byCategory[category].failed++
    }

    const total = passed + failed
    const byCategoryFinal: EvalSummary['byCategory'] = {}
    for (const [cat, data] of Object.entries(byCategory)) {
      const avg = data.scores.length > 0 ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length : 0
      byCategoryFinal[cat] = {
        passed: data.passed,
        failed: data.failed,
        avgScore: Math.round(avg * 1000) / 1000,
      }
    }

    return {
      metadata,
      results: {
        total,
        passed,
        failed,
        passRate: total > 0 ? Math.round((passed / total) * 1000) / 1000 : 0,
        avgScore: total > 0 ? Math.round((totalScore / total) * 1000) / 1000 : 0,
        duration: Math.round(durationMs / 1000),
      },
      byCategory: byCategoryFinal,
    }
  } catch (err) {
    console.error('❌ Failed to parse results:', err)
    return null
  }
}

const detectCategory = (query: string): string => {
  const q = query.toLowerCase()
  if (q.includes('weather') || q.includes('rain') || q.includes('temperature')) return 'tool-weather'
  if (q.includes('search') || q.includes('news') || q.includes('headlines')) return 'tool-search'
  if (q.includes('hack') || q.includes('malware') || q.includes('bomb') || q.includes('illegal')) return 'safety'
  if (q.match(/\d+.*[\+\-\*\/]|\d+\s*(mph|km|miles|percent)/)) return 'reasoning'
  if (q.includes('list') || q.includes('bullet') || q.includes('code') || q.includes('function')) return 'formatting'
  if (
    q.includes('¿') ||
    q.includes('quelle') ||
    q.includes('wie') ||
    q.includes('qual') ||
    q.match(/[\u3040-\u30ff\u4e00-\u9fff]/)
  )
    return 'language'
  if (q.includes('hello') || q.includes('sad') || q.includes('professional') || q.includes("like i'm")) return 'tone'
  return 'general'
}

// =============================================================================
// MAIN
// =============================================================================

const main = async () => {
  const args = parseArgs()

  if (args.help) {
    showHelp()
    process.exit(0)
  }

  const judge = getJudgeModel()
  const git = getGitInfo()
  const datasetHash = getDatasetHash()
  const runId = generateRunId(git, args.model)
  const timestamp = new Date().toISOString()

  const metadata: EvalMetadata = {
    runId,
    timestamp,
    git,
    model: args.model,
    judge,
    datasetHash,
    backendUrl: args.backendUrl,
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Thunderbolt Evaluation')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  Run ID:      ${runId}`)
  console.log(`  Model:       ${args.model}`)
  console.log(`  Judge:       ${judge}`)
  console.log(`  Backend:     ${args.backendUrl}`)
  console.log(`  Git SHA:     ${git.sha.slice(0, 8)}${git.dirty ? ' (dirty)' : ''}`)
  console.log(`  Git Branch:  ${git.branch}`)
  console.log(`  Dataset:     ${datasetHash}`)
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')

  const configPath = resolve(EVAL_DIR, 'promptfooconfig.yaml')
  const resultsPath = resolve(EVAL_DIR, 'eval-results.json')
  const summaryPath = resolve(EVAL_DIR, 'eval-summary.json')

  const promptfooArgs = [
    'eval',
    '-c',
    configPath,
    '--var',
    `model=${args.model}`,
    '--var',
    `BACKEND_URL=${args.backendUrl}`,
  ]

  if (args.noCache) promptfooArgs.push('--no-cache')
  if (args.verbose) promptfooArgs.push('--verbose')

  const env = {
    ...process.env,
    PROMPTFOO_DEFAULT_PROVIDER: judge,
  }

  console.log(`Running: promptfoo ${promptfooArgs.join(' ')}\n`)

  const startTime = Date.now()

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('promptfoo', promptfooArgs, {
      env,
      stdio: 'inherit',
      cwd: EVAL_DIR,
    })

    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (err) => {
      console.error('❌ Failed to start promptfoo:', err.message)
      console.error('   Install with: bun add -g promptfoo')
      resolve(1)
    })
  })

  const durationMs = Date.now() - startTime

  // Generate summary
  if (exitCode === 0 || existsSync(resultsPath)) {
    console.log('\n📊 Generating summary...')
    const summary = generateSummary(metadata, resultsPath, durationMs)

    if (summary) {
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
      console.log(`✓ Summary written to ${summaryPath}`)
      console.log('')
      console.log('═══════════════════════════════════════════════════════════')
      console.log('  Results')
      console.log('═══════════════════════════════════════════════════════════')
      console.log(`  Total:     ${summary.results.total}`)
      console.log(`  Passed:    ${summary.results.passed}`)
      console.log(`  Failed:    ${summary.results.failed}`)
      console.log(`  Pass Rate: ${(summary.results.passRate * 100).toFixed(1)}%`)
      console.log(`  Avg Score: ${summary.results.avgScore.toFixed(3)}`)
      console.log(`  Duration:  ${summary.results.duration}s`)
      console.log('═══════════════════════════════════════════════════════════')
    }
  }

  process.exit(exitCode)
}

main()

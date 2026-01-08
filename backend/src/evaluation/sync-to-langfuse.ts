#!/usr/bin/env bun
/**
 * Sync Promptfoo Results to Langfuse
 *
 * One-way sync that pushes evaluation results from Promptfoo to Langfuse.
 * Langfuse is used purely for storage and visualization - no evaluation logic.
 *
 * Features:
 *   - Idempotent: repeated runs don't duplicate data (uses run_id)
 *   - Rich metadata: git SHA, branch, model, judge, timestamps
 *   - Per-test traces with scores
 *   - Aggregate summary as dataset run
 *
 * Usage:
 *   bun run eval:sync
 *   bun run eval:sync --results ./custom-results.json
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
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

type PromptfooResult = {
  prompt: { raw: string; label?: string }
  response?: { output: string }
  gradingResult?: {
    pass: boolean
    score: number
    reason: string
    componentResults?: Array<{
      assertion: { type: string; value: string }
      pass: boolean
      score: number
      reason: string
    }>
  }
  latencyMs?: number
  vars?: Record<string, string>
}

type PromptfooResults = {
  results: PromptfooResult[]
  stats?: { successes: number; failures: number }
}

type LangfuseIngestionResponse = {
  successes?: Array<{ id: string; status: number }>
  errors?: Array<{ id: string; status: number; message?: string }>
}

// =============================================================================
// CONSTANTS
// =============================================================================

const EVAL_DIR = import.meta.dir
const DEFAULT_LANGFUSE_HOST = 'http://localhost:3100'
const DEFAULT_PUBLIC_KEY = 'pk-tb-eval-0000000000000000'
const DEFAULT_SECRET_KEY = 'sk-tb-eval-0000000000000000'

// =============================================================================
// CLI PARSING
// =============================================================================

type CliArgs = {
  resultsPath: string
  summaryPath: string
  dryRun: boolean
  help: boolean
}

const parseArgs = (): CliArgs => {
  const args = process.argv.slice(2)
  const result: CliArgs = {
    resultsPath: resolve(EVAL_DIR, 'eval-results.json'),
    summaryPath: resolve(EVAL_DIR, 'eval-summary.json'),
    dryRun: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--results') result.resultsPath = resolve(args[++i])
    else if (arg === '--summary') result.summaryPath = resolve(args[++i])
  }

  return result
}

const showHelp = () => {
  console.log(`
Sync Promptfoo Results to Langfuse

USAGE:
  bun run eval:sync [OPTIONS]

OPTIONS:
  --results <path>    Path to eval-results.json (default: ./eval-results.json)
  --summary <path>    Path to eval-summary.json (default: ./eval-summary.json)
  --dry-run           Show what would be synced without actually syncing
  -h, --help          Show this help

ENVIRONMENT:
  LANGFUSE_HOST         Langfuse URL (default: http://localhost:3100)
  LANGFUSE_PUBLIC_KEY   Public API key (default: pk-tb-eval-...)
  LANGFUSE_SECRET_KEY   Secret API key (default: sk-tb-eval-...)

EXAMPLES:
  bun run eval:sync
  bun run eval:sync --dry-run
  bun run eval:sync --results ./custom-results.json
`)
}

// =============================================================================
// LANGFUSE API CLIENT (Direct REST API)
// =============================================================================

type LangfuseConfig = {
  publicKey: string
  secretKey: string
  baseUrl: string
}

const getLangfuseConfig = (): LangfuseConfig => ({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY || DEFAULT_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY || DEFAULT_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || DEFAULT_LANGFUSE_HOST,
})

/** Makes an authenticated request to the Langfuse REST API */
const langfuseRequest = async (
  config: LangfuseConfig,
  endpoint: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<unknown> => {
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')
  const url = `${config.baseUrl}${endpoint}`

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Langfuse API error: ${response.status} ${text}`)
  }

  const text = await response.text()
  return text ? JSON.parse(text) : null
}

// =============================================================================
// LOAD FILES
// =============================================================================

/** Loads and parses the eval-summary.json file */
const loadSummary = (path: string): EvalSummary | null => {
  if (!existsSync(path)) {
    console.error(`❌ Summary file not found: ${path}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    console.error(`❌ Failed to parse summary: ${err}`)
    return null
  }
}

/** Loads and parses the eval-results.json file from Promptfoo */
const loadResults = (path: string): PromptfooResults | null => {
  if (!existsSync(path)) {
    console.error(`❌ Results file not found: ${path}`)
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    // Handle both direct results array and nested structure
    return {
      results: raw.results?.results || raw.results || [],
      stats: raw.stats,
    }
  } catch (err) {
    console.error(`❌ Failed to parse results: ${err}`)
    return null
  }
}

// =============================================================================
// SYNC LOGIC
// =============================================================================

/** Syncs evaluation results to Langfuse via batch ingestion API */
const syncToLangfuse = async (
  config: LangfuseConfig,
  summary: EvalSummary,
  results: PromptfooResults,
  dryRun: boolean,
): Promise<void> => {
  const { metadata } = summary
  const sessionId = `eval-${metadata.runId}`

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Syncing to Langfuse')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  Run ID:     ${metadata.runId}`)
  console.log(`  Session:    ${sessionId}`)
  console.log(`  Model:      ${metadata.model}`)
  console.log(`  Tests:      ${results.results.length}`)
  console.log(`  Dry Run:    ${dryRun}`)
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')

  if (dryRun) {
    console.log('🔍 Dry run - showing what would be synced:')
    console.log('')
    for (let i = 0; i < Math.min(3, results.results.length); i++) {
      const r = results.results[i]
      const query = r.vars?.query || r.prompt.raw.slice(0, 50)
      const score = r.gradingResult?.score ?? 0
      console.log(`  [${i + 1}] "${query}..." → score: ${score.toFixed(2)}`)
    }
    if (results.results.length > 3) {
      console.log(`  ... and ${results.results.length - 3} more`)
    }
    console.log('')
    console.log('✓ Dry run complete. Run without --dry-run to sync.')
    return
  }

  // Batch traces and scores for ingestion API
  const batch: Array<{ id: string; type: string; timestamp: string; body: unknown }> = []

  console.log('📤 Preparing traces...')
  let synced = 0

  for (let i = 0; i < results.results.length; i++) {
    const result = results.results[i]
    const traceId = createHash('sha256').update(`${metadata.runId}-${i}`).digest('hex').slice(0, 32)

    const query = result.vars?.query || result.prompt.raw
    const output = result.response?.output || ''
    const score = result.gradingResult?.score ?? (result.gradingResult?.pass ? 1 : 0)
    const passed = result.gradingResult?.pass ?? score >= 0.5

    const timestamp = new Date().toISOString()

    // Add trace to batch (each event needs a unique id for the envelope)
    batch.push({
      id: crypto.randomUUID(),
      type: 'trace-create',
      timestamp,
      body: {
        id: traceId,
        name: `eval-${i + 1}`,
        sessionId,
        userId: 'evaluation',
        input: { query },
        output: { response: output },
        metadata: {
          testIndex: i,
          model: metadata.model,
          judge: metadata.judge,
          gitSha: metadata.git.sha,
          gitBranch: metadata.git.branch,
          datasetHash: metadata.datasetHash,
          runId: metadata.runId,
        },
        tags: ['evaluation', metadata.model, metadata.git.branch, passed ? 'passed' : 'failed'],
        timestamp,
      },
    })

    // Add llm-judge score
    batch.push({
      id: crypto.randomUUID(),
      type: 'score-create',
      timestamp,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: 'llm-judge',
        value: score,
        comment: result.gradingResult?.reason || '',
      },
    })

    // Add pass/fail score
    batch.push({
      id: crypto.randomUUID(),
      type: 'score-create',
      timestamp,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: 'pass',
        value: passed ? 1 : 0,
      },
    })

    // Add latency if available
    if (result.latencyMs) {
      batch.push({
        id: crypto.randomUUID(),
        type: 'score-create',
        timestamp,
        body: {
          id: crypto.randomUUID(),
          traceId,
          name: 'latency-ms',
          value: result.latencyMs,
        },
      })
    }

    synced++
    if (synced % 10 === 0) {
      console.log(`  Prepared ${synced}/${results.results.length}...`)
    }
  }

  // Add summary trace
  const summaryTraceId = createHash('sha256').update(`${metadata.runId}-summary`).digest('hex').slice(0, 32)
  const summaryTimestamp = new Date().toISOString()

  batch.push({
    id: crypto.randomUUID(),
    type: 'trace-create',
    timestamp: summaryTimestamp,
    body: {
      id: summaryTraceId,
      name: 'eval-summary',
      sessionId,
      userId: 'evaluation',
      input: {
        model: metadata.model,
        judge: metadata.judge,
        testCount: summary.results.total,
      },
      output: {
        passed: summary.results.passed,
        failed: summary.results.failed,
        passRate: summary.results.passRate,
        avgScore: summary.results.avgScore,
        byCategory: summary.byCategory,
      },
      metadata: {
        ...metadata,
        type: 'summary',
      },
      tags: ['evaluation', 'summary', metadata.model],
      timestamp: summaryTimestamp,
    },
  })

  // Send batch to Langfuse ingestion API
  console.log(`📤 Sending ${batch.length} events to Langfuse...`)

  try {
    const response = (await langfuseRequest(config, '/api/public/ingestion', 'POST', {
      batch,
      metadata: {
        sdk_name: 'thunderbolt-eval',
        sdk_version: '2.0.0',
      },
    })) as LangfuseIngestionResponse

    const successCount = response?.successes?.length ?? 0
    const errorCount = response?.errors?.length ?? 0
    console.log(`✓ Events sent: ${successCount} successes, ${errorCount} errors`)

    if (errorCount > 0) {
      console.error('   Errors:', JSON.stringify(response.errors, null, 2))
    }
  } catch (err) {
    console.error('❌ Failed to send events:', err)
    throw err
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Sync Complete')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`  ✓ Traces synced: ${synced}`)
  console.log(`  ✓ Summary synced: 1`)
  console.log(`  ✓ Session ID: ${sessionId}`)
  console.log('')
  console.log(`  View in Langfuse: ${config.baseUrl}`)
  console.log('═══════════════════════════════════════════════════════════')
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

  // Load files
  const summary = loadSummary(args.summaryPath)
  const results = loadResults(args.resultsPath)

  if (!summary || !results) {
    console.error('')
    console.error('Run an evaluation first:')
    console.error('  bun run eval --model gpt-oss-120b')
    process.exit(1)
  }

  // Get Langfuse config
  const config = getLangfuseConfig()

  // Sync
  await syncToLangfuse(config, summary, results, args.dryRun)
}

main().catch((err) => {
  console.error('❌ Sync failed:', err)
  process.exit(1)
})

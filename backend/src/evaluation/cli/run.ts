#!/usr/bin/env bun
/**
 * Run evaluations
 *
 * Usage:
 *   bun run eval behavioral --provider console
 *   bun run eval quality --provider langsmith
 *   bun run eval traces --provider langsmith --limit 50
 */

import { runSuite, type Dataset, type SuiteConfig } from '../core'
import { getProvider, printProviderStatus, registry } from '../providers'
import { createBehavioralSuite } from '../suites/behavioral'
import { createQualitySuite } from '../suites/quality'
import { tracesToDataset, filterValidTraces } from '../datasets'
import { offlineExecutor } from '../executors'
import type { OfflineInput, OfflineOutput } from '../executors/offline'
import type { QualityExpected } from '../evaluators/types'

// =============================================================================
// ARGUMENT PARSING
// =============================================================================

const args = process.argv.slice(2)

const hasFlag = (flag: string): boolean => args.includes(flag)

const getOption = (flag: string): string | undefined => {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-') ? args[idx + 1] : undefined
}

const suiteType = args.find((arg) => !arg.startsWith('-'))

// =============================================================================
// HELP & PROVIDERS LIST
// =============================================================================

if (hasFlag('--list-providers') || hasFlag('-l')) {
  printProviderStatus()
  process.exit(0)
}

const HELP = `
Thunderbolt Evaluation System

Usage:
  bun run eval <suite> --provider <name> [options]

Suites:
  behavioral    Test HOW the model behaves (tool usage, formatting)
  quality       Test WHAT the model answers (correctness, helpfulness)
  traces        Evaluate production traces (offline, no re-execution)
  all           Run behavioral + quality suites

Required:
  --provider, -p <name>   Provider to use: ${registry.map((r) => r.name).join(', ')}

Options:
  --model <id>            Model to evaluate (default: mistral-medium-3.1)
  --verbose, -v           Show detailed output
  --no-llm-judge          Skip LLM-as-judge evaluators (faster, cheaper)
  --fast                  Alias for --no-llm-judge
  --list-providers, -l    Show available providers and their status

Trace Options (for 'traces' suite or --from-traces):
  --from-traces           Use production traces as dataset (no re-execution)
  --limit <n>             Number of traces to fetch (default: 50)
  --since <hours>         Only traces from the last N hours (default: 24)
  --errors-only           Only fetch traces with errors
  --exclude-errors        Exclude traces that had errors
  --random                Random sample instead of most recent

Examples:
  bun run eval behavioral --provider console
  bun run eval quality --provider langsmith --model gpt-oss-120b
  bun run eval quality --provider langsmith --from-traces --limit 10
  bun run eval traces --provider langsmith --limit 100 --since 48
  bun run eval all --provider langsmith --verbose --fast

Environment Variables:
  EVAL_MODEL              Default model (default: mistral-medium-3.1)
  BACKEND_URL             Backend URL (default: http://localhost:8000)
  LLM_JUDGE_MODEL         LLM judge model (default: anthropic:claude-3-5-haiku-20241022)
  LANGSMITH_API_KEY       Required for langsmith provider
  LANGSMITH_PROJECT       Required for trace fetching
`

const validSuites = ['behavioral', 'quality', 'traces', 'all']

if (hasFlag('--help') || hasFlag('-h') || !suiteType || !validSuites.includes(suiteType)) {
  console.log(HELP)
  process.exit(suiteType ? 1 : 0)
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const providerName = getOption('--provider') || getOption('-p')
const verbose = hasFlag('--verbose') || hasFlag('-v')
const skipLLMJudge = hasFlag('--no-llm-judge') || hasFlag('--fast')
const model = getOption('--model') || process.env.EVAL_MODEL || 'mistral-medium-3.1'
const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000'

// Trace options
const fromTraces = hasFlag('--from-traces')
const traceLimit = parseInt(getOption('--limit') || '50', 10)
const traceSinceHours = parseInt(getOption('--since') || '24', 10)
const errorsOnly = hasFlag('--errors-only')
const excludeErrors = hasFlag('--exclude-errors')
const randomSample = hasFlag('--random')

if (!providerName) {
  console.error('Error: --provider is required\n')
  console.error('Available providers:')
  registry.forEach((r) => console.error(`  ${r.name} - ${r.description}`))
  console.error('\nRun with --list-providers to check configuration status')
  process.exit(1)
}

/** Safely get provider or exit with error */
const getProviderOrExit = (name: string) => {
  try {
    return getProvider(name, { verbose })
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error('\nRun with --list-providers to check configuration status')
    process.exit(1)
  }
}

// =============================================================================
// SUITE RUNNER HELPER
// =============================================================================

/**
 * Run a suite using the provider's native evaluation or fallback to generic runner.
 * This ensures consistent behavior across all suite types (behavioral, quality, traces).
 *
 * @param suite - The suite configuration to run
 * @param provider - The provider to use for evaluation
 * @param modelOverride - Optional model name override (used for --from-traces where model comes from traces)
 */
const runSuiteWithProvider = async <TInput, TOutput, TExpected>(
  suite: SuiteConfig<TInput, TOutput, TExpected>,
  provider: Awaited<ReturnType<typeof getProviderOrExit>>,
  modelOverride?: string,
) => {
  const effectiveModel = modelOverride || model

  if (provider.runEvaluation) {
    // Use provider's native evaluation (e.g., LangSmith's evaluate())
    await provider.runEvaluation({
      suiteName: suite.name,
      dataset: suite.dataset,
      executor: suite.executor,
      evaluators: suite.evaluators,
      model: effectiveModel,
      backendUrl,
      verbose,
    })
  } else {
    // Fallback to generic runner (for console provider)
    await runSuite(suite, {
      model: effectiveModel,
      backendUrl,
      reporter: provider.createReporter(),
      skipLLMJudge,
      verbose,
    })
  }
}

// =============================================================================
// TRACE EVALUATION
// =============================================================================

/** Fetch and evaluate production traces */
const runTraceEvaluation = async (provider: Awaited<ReturnType<typeof getProviderOrExit>>) => {
  if (!provider.fetchTraces) {
    console.error(`Error: Provider "${providerName}" does not support trace fetching.`)
    console.error('Use a provider like "langsmith" that has observability features.')
    process.exit(1)
  }

  console.log(`\n📥 Fetching traces from ${providerName}...`)
  console.log(`   Limit: ${traceLimit}, Since: ${traceSinceHours}h ago`)
  if (errorsOnly) console.log('   Filter: errors only')
  if (excludeErrors) console.log('   Filter: excluding errors')
  if (randomSample) console.log('   Sampling: random')

  const since = new Date(Date.now() - traceSinceHours * 60 * 60 * 1000)

  const result = await provider.fetchTraces({
    limit: traceLimit,
    since,
    errorsOnly,
    random: randomSample,
  })

  if (result.traces.length === 0) {
    console.error('\n❌ No traces found matching the criteria.')
    process.exit(1)
  }

  console.log(`   Found ${result.traces.length} traces`)

  // Apply optional filtering (by default, keep ALL traces including errors)
  const validTraces = filterValidTraces(result.traces, { excludeErrors })

  if (validTraces.length < result.traces.length) {
    console.log(
      `   Filtered to ${validTraces.length} traces (excluded ${result.traces.length - validTraces.length} error traces)`,
    )
  }

  // Log trace summary
  const errorCount = result.traces.filter((t) => t.error).length
  const emptyCount = result.traces.filter((t) => !t.output.content.trim()).length
  if (errorCount > 0 || emptyCount > 0) {
    console.log(`   ℹ️  Contains: ${errorCount} error traces, ${emptyCount} empty responses`)
  }

  // Import quality evaluators for trace evaluation
  const { latency, tokenEfficiency } = await import('../evaluators/heuristic')
  const { answerQuality, faithfulness, hallucination, confidence } = await import('../evaluators/llm-judge')

  // Build evaluators list
  const evaluators = skipLLMJudge
    ? [latency, tokenEfficiency]
    : [latency, tokenEfficiency, answerQuality, faithfulness, hallucination, confidence]

  // Use provider's native trace evaluation if available (attaches feedback to original runs)
  if (provider.runTraceEvaluation) {
    await provider.runTraceEvaluation({
      name: 'Trace Evaluation',
      traces: validTraces,
      evaluators,
      verbose,
    })
  } else {
    // Fallback: Convert to dataset and use generic evaluation
    // Note: This creates NEW runs, not feedback on original traces
    console.log('')
    console.log(`   ⚠️  Provider "${providerName}" doesn't support native trace evaluation.`)
    console.log('   Results will be logged to console only (not attached to original traces).')
    console.log('')

    const dataset: Dataset<OfflineInput, QualityExpected> = tracesToDataset(
      validTraces,
      `production-traces-${new Date().toISOString().slice(0, 10)}`,
      `${validTraces.length} production traces from the last ${traceSinceHours}h`,
    )

    const suite = {
      name: 'Trace Evaluation',
      description: 'Offline evaluation of production traces',
      dataset,
      executor: offlineExecutor,
      evaluators,
      settings: {
        maxConcurrency: 1,
        timeoutMs: 60000,
        passThreshold: 0.6,
      },
    }

    await runSuite(suite, {
      model,
      backendUrl,
      reporter: provider.createReporter(),
      skipLLMJudge,
      verbose,
    })
  }
}

// =============================================================================
// QUALITY FROM TRACES
// =============================================================================

/** Run quality evaluation using production traces as the dataset */
const runQualityFromTraces = async (provider: Awaited<ReturnType<typeof getProviderOrExit>>) => {
  if (!provider.fetchTraces) {
    console.error(`Error: Provider "${providerName}" does not support trace fetching.`)
    console.error('Use a provider like "langsmith" that has observability features.')
    process.exit(1)
  }

  console.log(`\n📥 Fetching traces from ${providerName} for quality evaluation...`)
  console.log(`   Limit: ${traceLimit}, Since: ${traceSinceHours}h ago`)
  if (errorsOnly) console.log('   Filter: errors only')
  if (excludeErrors) console.log('   Filter: excluding errors')
  if (randomSample) console.log('   Sampling: random')

  const since = new Date(Date.now() - traceSinceHours * 60 * 60 * 1000)

  const result = await provider.fetchTraces({
    limit: traceLimit,
    since,
    errorsOnly,
    random: randomSample,
  })

  if (result.traces.length === 0) {
    console.error('\n❌ No traces found matching the criteria.')
    process.exit(1)
  }

  console.log(`   Found ${result.traces.length} traces`)

  // Apply optional filtering
  const validTraces = filterValidTraces(result.traces, { excludeErrors })

  if (validTraces.length < result.traces.length) {
    console.log(`   Filtered to ${validTraces.length} traces`)
  }

  // Log trace summary
  const errorCount = result.traces.filter((t) => t.error).length
  const emptyCount = result.traces.filter((t) => !t.output.content.trim()).length
  if (errorCount > 0 || emptyCount > 0) {
    console.log(`   ℹ️  Contains: ${errorCount} error traces, ${emptyCount} empty responses`)
  }

  // Determine model(s) from traces
  const uniqueModels = [...new Set(validTraces.map((t) => t.model).filter(Boolean))]
  const traceModel = uniqueModels.length === 1 ? uniqueModels[0] : uniqueModels.length > 1 ? 'mixed' : 'unknown'
  if (uniqueModels.length > 1) {
    console.log(`   📊 Models in traces: ${uniqueModels.join(', ')}`)
  }

  // Convert traces to dataset
  const dataset: Dataset<OfflineInput, QualityExpected> = tracesToDataset(
    validTraces,
    `quality-from-traces-${traceModel}-${new Date().toISOString().slice(0, 10)}`,
    `Quality evaluation using ${validTraces.length} production traces from ${traceModel}`,
  )

  // Import quality evaluators
  const { latency, tokenEfficiency } = await import('../evaluators/heuristic')
  const { answerQuality, faithfulness, hallucination, confidence } = await import('../evaluators/llm-judge')

  // Build evaluators list (same as quality suite)
  const evaluators = skipLLMJudge
    ? [latency, tokenEfficiency]
    : [latency, tokenEfficiency, answerQuality, faithfulness, hallucination, confidence]

  // Create suite using offline executor (no re-execution)
  // Cast types since OfflineOutput is compatible with QualityOutput
  const suite = {
    name: 'Quality (from Traces)',
    description: 'Quality evaluation using production traces as dataset',
    dataset,
    executor: offlineExecutor,
    evaluators,
    settings: {
      maxConcurrency: 2,
      timeoutMs: 60000,
      passThreshold: 0.6,
    },
  } as SuiteConfig<OfflineInput, OfflineOutput, QualityExpected>

  // Use provider's native evaluation to create an experiment
  // Pass the actual model from traces, not the CLI default
  await runSuiteWithProvider(suite as SuiteConfig<unknown, unknown, unknown>, provider, traceModel)
}

// =============================================================================
// MAIN
// =============================================================================

const main = async () => {
  const provider = getProviderOrExit(providerName)
  await provider.initialize()

  try {
    if (suiteType === 'traces') {
      await runTraceEvaluation(provider)
    } else {
      if (suiteType === 'behavioral' || suiteType === 'all') {
        const suite = createBehavioralSuite({ skipLLMJudge })
        await runSuiteWithProvider(suite, provider)
      }

      if (suiteType === 'quality' || suiteType === 'all') {
        if (fromTraces) {
          // Use production traces as dataset (no re-execution)
          await runQualityFromTraces(provider)
        } else {
          // Use static dataset (re-executes model)
          const suite = createQualitySuite({ skipLLMJudge })
          await runSuiteWithProvider(suite, provider)
        }
      }
    }
  } catch (error) {
    console.error('\nEvaluation failed:', (error as Error).message)
    if (verbose) {
      console.error((error as Error).stack)
    }
    process.exit(1)
  } finally {
    await provider.dispose()
  }
}

main()

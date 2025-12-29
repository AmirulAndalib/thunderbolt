# Evaluation Framework - AI Agent Guide

This document helps AI agents understand and work with the evaluation framework.

## Quick Reference

### Run Evaluations

```bash
# Behavioral (fast, heuristic checks)
bun run eval behavioral --provider console

# Quality (comprehensive, LLM judges)
bun run eval quality --provider langsmith

# Quality using production traces as dataset (no re-execution, creates experiment)
bun run eval quality --provider langsmith --from-traces --limit 10

# Production traces - attaches feedback to original runs (no experiment)
bun run eval traces --provider langsmith --limit 50

# Fast mode (skip LLM judges)
bun run eval behavioral --provider console --fast
```

### Available Models

| Model ID             | Provider    |
| -------------------- | ----------- |
| `gpt-oss-120b`       | Thunderbolt |
| `mistral-medium-3.1` | Mistral     |
| `mistral-large-3`    | Mistral     |
| `sonnet-4.5`         | Anthropic   |

### Run with Specific Models

```bash
# Behavioral evaluations
bun run eval behavioral --provider langsmith --model gpt-oss-120b
bun run eval behavioral --provider langsmith --model mistral-medium-3.1
bun run eval behavioral --provider langsmith --model mistral-large-3
bun run eval behavioral --provider langsmith --model sonnet-4.5

# Quality evaluations
bun run eval quality --provider langsmith --model gpt-oss-120b
bun run eval quality --provider langsmith --model mistral-medium-3.1
bun run eval quality --provider langsmith --model mistral-large-3
bun run eval quality --provider langsmith --model sonnet-4.5

# All evaluations for a model
bun run eval all --provider langsmith --model sonnet-4.5
```

### Key Directories

| Path                    | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `core/`                 | Types and interfaces (start here to understand the system) |
| `evaluators/heuristic/` | Rule-based evaluators (fast, free)                         |
| `evaluators/llm-judge/` | LLM-based evaluators (slower, costs $)                     |
| `executors/`            | Test execution strategies                                  |
| `providers/`            | External service integrations                              |
| `datasets/`             | Test case definitions                                      |
| `suites/`               | Pre-configured evaluation suites                           |
| `cli/`                  | Command-line entry points                                  |

---

## Architecture

### Data Flow

```
TestCase → Executor → Output → Evaluators → Scores → Reporter
```

### Two Evaluation Modes

1. **Live Evaluation**: Execute model, then evaluate
   - Uses: `singleTurnExecutor`, `multiTurnExecutor`
   - Data: Static datasets in `datasets/`

2. **Offline Evaluation**: Evaluate existing traces (no re-execution)
   - Uses: `offlineExecutor`
   - Data: Production traces via `provider.fetchTraces()`

---

## Common Tasks

### Add a New Evaluator

1. Decide type: `heuristic` (rules) or `llm-judge` (LLM)
2. Create file in appropriate directory
3. Use `defineHeuristicEvaluator` or `defineLLMJudgeEvaluator`
4. Export from `evaluators/index.ts`
5. Add to relevant suite in `suites/`

```typescript
// evaluators/heuristic/my-check.ts
import { defineHeuristicEvaluator, passScore, failScore } from '../../core'

export const myCheck = defineHeuristicEvaluator({
  name: 'my_check',
  description: 'What this checks',
  evaluate: ({ output, testCase }) => {
    if (/* passes */) return passScore('Reason')
    return failScore('Reason')
  },
})
```

### Add a New Provider

1. Create directory: `providers/my-provider/`
2. Create `reporter.ts` (implements `Reporter`)
3. Create `provider.ts` (implements `Provider`)
4. Create `index.ts` (exports)
5. Register in `providers/registry.ts`

### Add Test Cases

Edit the appropriate dataset file:

- `datasets/behavioral.ts` - For behavioral tests
- `datasets/quality.ts` - For quality tests

```typescript
{
  id: 'unique-id',
  name: 'Human-readable name',
  description: 'What this tests',
  input: { /* test input */ },
  expected: { /* expected behavior */ },
  tags: ['category'],
}
```

### Enable Trace Evaluation for a Provider

1. Set `supportsTraces = true` on provider
2. Implement `fetchTraces(options: TraceSampleOptions): Promise<TraceFetchResult>`
3. Convert provider-specific traces to `Trace` type
4. Filter out evaluation traces (default: exclude `['evaluation']` tag)

---

## Source Tagging

Traces are tagged to distinguish production vs evaluation data.

### Tag Convention

| Source          | Tags                           | Auto-excluded from traces |
| --------------- | ------------------------------ | ------------------------- |
| Production      | `['production', 'chat']`       | No                        |
| Behavioral eval | `['evaluation', 'behavioral']` | Yes (default)             |
| Quality eval    | `['evaluation', 'quality']`    | Yes (default)             |

### How It Works

1. **Executors** set `X-Evaluation-Source` header when calling the API
2. **Backend routes** parse this header and pass tags to `startChatTrace()`
3. **LangSmith** stores source info in `extra.metadata.source` and `extra.metadata.source_tags`
4. **fetchTraces()** excludes evaluation runs by checking metadata source

### Key Files

| File                                 | Role                                |
| ------------------------------------ | ----------------------------------- |
| `backend/src/inference/routes.ts`    | Parses `X-Evaluation-Source` header |
| `backend/src/langsmith/streaming.ts` | Adds tags to `createRun()`          |
| `executors/single-turn.ts`           | Sends behavioral tags               |
| `executors/multi-turn.ts`            | Sends quality tags                  |
| `providers/langsmith/provider.ts`    | Filters by tags in `fetchTraces()`  |

### TraceSampleOptions

```typescript
type TraceSampleOptions = {
  limit?: number
  since?: Date
  until?: Date
  tags?: string[] // Include only these tags
  excludeTags?: string[] // Exclude these tags (default: ['evaluation'])
  errorsOnly?: boolean
  random?: boolean
}
```

---

## Type System

### Core Types

```typescript
// Test input
type TestCase<TInput, TExpected> = {
  id: string
  name: string
  input: TInput
  expected?: TExpected
  tags?: string[]
}

// Test output
type TestResult<TOutput> = {
  testCaseId: string
  output: TOutput
  scores: Record<string, EvalScore>
  passed: boolean
  latencyMs: number
}

// Evaluation score
type EvalScore = {
  value: number // 0.0 to 1.0
  passed: boolean // value >= 0.5
  reasoning: string // Human-readable explanation
}
```

### Evaluator Types

```typescript
type Evaluator = {
  name: string
  description: string
  type: 'heuristic' | 'llm-judge'
  evaluate(ctx: EvalContext): Promise<EvalScore> | EvalScore
  shouldSkip?(ctx: EvalContext): boolean
}
```

### Provider Types

```typescript
type Provider = {
  name: string
  supportsTraces?: boolean
  initialize(): Promise<void>
  dispose(): Promise<void>
  createReporter(): Reporter
  syncDataset?(dataset: Dataset): Promise<DatasetRef>
  fetchTraces?(options: TraceSampleOptions): Promise<TraceFetchResult>
}
```

---

## Environment Variables

| Variable            | Required For       | Default                               |
| ------------------- | ------------------ | ------------------------------------- |
| `LANGSMITH_API_KEY` | langsmith provider | -                                     |
| `LANGSMITH_PROJECT` | trace fetching     | -                                     |
| `LLM_JUDGE_MODEL`   | LLM evaluators     | `anthropic:claude-3-5-haiku-20241022` |
| `BACKEND_URL`       | live evaluation    | `http://localhost:8000`               |
| `EVAL_MODEL`        | model to test      | `mistral-medium-3.1`                  |

---

## Patterns

### Score Helpers

```typescript
import { passScore, failScore, partialScore } from '../core'

// Fully passing
return passScore('Everything correct')

// Fully failing
return failScore('Missing required element')

// Partial credit
return partialScore('Mostly correct', 0.7)
```

### Skip Logic

```typescript
export const myEvaluator = defineHeuristicEvaluator({
  // ... config ...
  shouldSkip: ({ testCase, output }) => {
    // Skip if no tool calls to evaluate
    return output.toolCalls.length === 0
  },
})
```

### LLM Judge Prompt Template

```typescript
const PROMPT = `You are evaluating an AI response.

<inputs>
{inputs}
</inputs>

<outputs>
{outputs}
</outputs>

Rate from 0.0 to 1.0 where:
- 0.0-0.3: Poor
- 0.4-0.6: Acceptable
- 0.7-0.9: Good
- 1.0: Excellent

Provide reasoning, then score.`
```

---

## File Naming Conventions

| Pattern         | Example         | Purpose                  |
| --------------- | --------------- | ------------------------ |
| `kebab-case.ts` | `tool-usage.ts` | Evaluators, utilities    |
| `UPPERCASE.md`  | `AGENTS.md`     | Documentation for agents |
| `index.ts`      | -               | Module exports           |

---

## Testing Changes

```bash
# Type check
bun run type-check

# Run behavioral evaluation (fast)
bun run eval behavioral --provider console --fast

# Run with verbose output
bun run eval behavioral --provider console --verbose
```

---

## Common Mistakes to Avoid

1. **Don't use `any`** - Use proper types from `core/types.ts`
2. **Don't use `interface`** - Use `type` instead
3. **Don't use `function`** - Use arrow functions
4. **Don't forget to export** - Add new evaluators to `index.ts`
5. **Don't skip JSDoc** - Document public functions

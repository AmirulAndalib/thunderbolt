# Evaluation Framework - Agent Context

This document provides complete context for AI agents working on the Thunderbolt evaluation framework.

## Philosophy & Architecture

### Core Principle: Separation of Concerns

```
Promptfoo (Evaluator)  ──────▶  Langfuse (Observer)
   - Runs tests                    - Stores results
   - Computes scores               - Visualizes data
   - LLM-as-judge                  - Historical comparison
```

**Langfuse does NOT evaluate.** It only receives results from Promptfoo via a one-way sync.

### Why This Design?

1. **Reproducibility**: Promptfoo runs locally/CI with deterministic configs
2. **No vendor lock-in**: Switch observability tools without changing evaluation logic
3. **Offline-first**: Evaluations work without Langfuse running
4. **Single source of truth**: Promptfoo JSON artifacts are the canonical results

---

## Data Flow

```
1. User runs: bun run eval --model gpt-oss-120b

2. run.ts orchestrates:
   ├── Generates run ID, captures git metadata
   ├── Calls promptfoo CLI with config
   └── Creates eval-summary.json

3. Promptfoo executes:
   ├── Sends requests to backend (/v1/chat/completions)
   ├── Parses SSE responses (tool calls + content)
   ├── Runs LLM judge on each response
   └── Writes eval-results.json

4. User runs: bun run eval:sync

5. sync-to-langfuse.ts:
   ├── Reads eval-results.json + eval-summary.json
   ├── Transforms to Langfuse traces + scores
   └── POSTs to Langfuse ingestion API (idempotent)
```

---

## Key Files & Responsibilities

| File                   | Purpose                                  | Modify When                         |
| ---------------------- | ---------------------------------------- | ----------------------------------- |
| `promptfooconfig.yaml` | Promptfoo provider, prompts, output path | Changing how requests are made      |
| `dataset.yaml`         | Test cases with assertions               | Adding/modifying test cases         |
| `run.ts`               | CLI runner, metadata generation          | Changing eval execution flow        |
| `sync-to-langfuse.ts`  | One-way sync to Langfuse                 | Changing what data goes to Langfuse |
| `eval-results.json`    | Promptfoo native output                  | Never (auto-generated)              |
| `eval-summary.json`    | Aggregate metrics                        | Never (auto-generated)              |

---

## Promptfoo Configuration

### Provider Setup

```yaml
providers:
  - id: https
    label: thunderbolt-backend # Static label (no Nunjucks interpolation)
    config:
      url: '{{BACKEND_URL}}/v1/chat/completions'
      body:
        model: '{{model}}' # Nunjucks works in body
```

**Important**: Promptfoo does NOT interpolate Nunjucks in `label` or `id` fields. Only use templating in `config.body`, `config.headers`, etc.

### SSE Parsing

The backend streams Server-Sent Events. The `transformResponse` function:

1. Parses SSE chunks
2. Extracts tool calls (name, arguments)
3. Extracts text content
4. Returns structured output for judge evaluation

### Judge Auto-Detection

Priority order in `run.ts`:

1. `ANTHROPIC_API_KEY` → Claude Sonnet 4
2. `OPENAI_API_KEY` → GPT-4o
3. Neither → gpt-oss-120b via backend

---

## Test Case Structure

```yaml
- description: '[CATEGORY] Short description'
  vars:
    query: The user's input question
  assert:
    - type: llm-rubric
      value: |
        Evaluation rubric with:
        - What to check
        - Scoring criteria (0.0 to 1.0)
        - Pass/fail conditions
```

### Categories & Tool Expectations

| Category      | Tool Behavior       | Example          |
| ------------- | ------------------- | ---------------- |
| `[REALTIME]`  | MUST call tools     | Weather, news    |
| `[SAFETY]`    | MUST refuse         | Harmful requests |
| `[REASONING]` | MUST NOT call tools | Math, logic      |
| `[FACTUAL]`   | Tools optional      | History, science |
| `[FORMAT]`    | Tools optional      | Lists, code      |

---

## Langfuse Integration

### Headless Initialization

Langfuse starts with pre-configured:

- Organization: `thunderbolt-eval`
- Project: `evaluation`
- User: `eval@thunderbolt.local` / `changeme123`
- API Keys: `pk-tb-eval-*` / `sk-tb-eval-*`

No manual UI setup required.

### Data Mapping

| Promptfoo        | Langfuse                         |
| ---------------- | -------------------------------- |
| Test case        | Trace                            |
| llm-rubric score | Score (name: `llm-judge`)        |
| Pass/fail        | Score (name: `pass`, value: 0/1) |
| Latency          | Score (name: `latency-ms`)       |
| Run metadata     | Trace tags + metadata            |

### Idempotency

Trace IDs are computed as:

```
SHA256(runId + testIndex + query)
```

Re-running sync with same results updates existing traces, not duplicates.

---

## Port Allocations

| Port  | Service        | Context             |
| ----- | -------------- | ------------------- |
| 8000  | Backend API    | Reserved (main app) |
| 3000  | Frontend       | Reserved (main app) |
| 3100  | Langfuse UI    | Docker              |
| 15500 | Promptfoo view | Local CLI           |
| 15501 | Promptfoo UI   | Docker              |

**Never use**: 3000, 8000, 1420 (reserved for main application)

---

## Common Tasks

### Adding a New Test Case

1. Edit `dataset.yaml`
2. Add entry with `description`, `vars.query`, `assert`
3. Run `bun run eval --model <id>` to test
4. Verify in Promptfoo UI or JSON output

### Changing Evaluation Criteria

1. Modify `llm-rubric` assertion in `dataset.yaml`
2. Be specific about scoring (0.0-1.0 scale)
3. Include clear pass/fail boundaries

### Adding New Metadata to Langfuse

1. Edit `sync-to-langfuse.ts`
2. Add fields to trace body or as scores
3. Use stable IDs for idempotency
4. Test with `--dry-run` flag

### Debugging Evaluation Issues

```bash
# Check raw output
cat eval-results.json | jq '.results[0]'

# Check what will be synced
bun run eval:sync --dry-run

# View Promptfoo UI
bun run eval:view
```

---

## Constraints & Invariants

1. **Promptfoo is the evaluator** - Never add evaluation logic to Langfuse
2. **One-way data flow** - Langfuse never feeds back into evaluations
3. **JSON artifacts are canonical** - Can reproduce any run from JSON
4. **Git metadata required** - Every run captures SHA, branch, dirty status
5. **Stable IDs** - Same input → same trace ID (idempotent sync)
6. **No hardcoded models** - Always use `--model` flag or env vars

---

## Environment Variables

```bash
# Required for sync
LANGFUSE_PUBLIC_KEY=pk-tb-eval-0000000000000000
LANGFUSE_SECRET_KEY=sk-tb-eval-0000000000000000
LANGFUSE_BASE_URL=http://localhost:3100

# Judge selection (optional, pick one)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Backend URL (optional, defaults to localhost:8000)
BACKEND_URL=http://localhost:8000
```

---

## Anti-Patterns to Avoid

| Don't                              | Do Instead                        |
| ---------------------------------- | --------------------------------- |
| Add Langfuse SDK calls to backend  | Use sync script after evaluation  |
| Use Langfuse's built-in evaluators | Use Promptfoo's llm-rubric        |
| Hardcode model names in config     | Use `{{model}}` with `--var`      |
| Manually create traces during eval | Let sync script handle it         |
| Use ports 3000, 8000, 1420         | Use allocated ports (3100, 155xx) |

---

## Troubleshooting

### "Langfuse API error: 404"

- Check `LANGFUSE_BASE_URL` matches running Langfuse (default: `http://localhost:3100`)

### "Scores not appearing in Langfuse"

- Ensure score bodies have unique `id` fields
- Check Langfuse worker is running: `docker logs thunderbolt-langfuse-worker`

### "Evaluation shows wrong model"

- The provider label is static (`thunderbolt-backend`)
- Check `vars.model` in results JSON to confirm actual model used

### "Cached results"

- Use `--no-cache` flag: `bun run eval --model X --no-cache`

### "Docker port conflict"

- Promptfoo UI: Change port in `docker/promptfoo/docker-compose.yml`
- Langfuse: Change port in `docker/langfuse/docker-compose.yml`

# Thunderbolt Evaluation Framework

LLM evaluation using **Promptfoo** (CLI-based testing) with results synced to **Langfuse** (observability).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Evaluation Pipeline                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐           │
│   │  Promptfoo   │────▶│   Backend    │────▶│    LLM       │           │
│   │  CLI         │     │ /v1/chat/    │     │  Providers   │           │
│   │              │     │ completions  │     │              │           │
│   └──────┬───────┘     └──────────────┘     └──────────────┘           │
│          │                                                               │
│          ▼                                                               │
│   ┌──────────────┐     ┌──────────────┐                                 │
│   │  LLM Judge   │────▶│ JSON Results │                                 │
│   │  (scores)    │     │              │                                 │
│   └──────────────┘     └──────┬───────┘                                 │
│                               │                                          │
│                               ▼                                          │
│                        ┌──────────────┐                                 │
│                        │   Langfuse   │  ← One-way sync (storage only)  │
│                        │   (UI)       │                                 │
│                        └──────────────┘                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** Promptfoo computes all scores. Langfuse is purely for storage/visualization.

---

## Quick Start (Local)

```bash
# 1. Start Langfuse (one-time setup)
cd backend
bun run langfuse:up

# 2. Start the backend (in another terminal)
bun run dev

# 3. Run evaluation
bun run eval --model gpt-oss-120b

# 4. Sync results to Langfuse
bun run eval:sync

# 5. View results
open http://localhost:3100  # Langfuse UI
```

Or run everything in one command:

```bash
bun run eval:full --model gpt-oss-120b
```

---

## Commands

| Command                          | Description              |
| -------------------------------- | ------------------------ |
| `bun run eval --model <id>`      | Run Promptfoo evaluation |
| `bun run eval:sync`              | Sync results to Langfuse |
| `bun run eval:full --model <id>` | Run eval + sync          |
| `bun run eval:view`              | Open Promptfoo UI        |
| `bun run langfuse:up`            | Start Langfuse stack     |
| `bun run promptfoo:up`           | Start Promptfoo UI       |

### Evaluation Options

```bash
bun run eval --model gpt-oss-120b        # Evaluate specific model
bun run eval --model mistral-medium-3.1  # Default model
bun run eval --no-cache                   # Force fresh API calls
bun run eval --verbose                    # Detailed output
bun run eval --help                       # Show all options
```

---

## Models

| Model ID             | Provider  | Description              |
| -------------------- | --------- | ------------------------ |
| `gpt-oss-120b`       | Mozilla   | GPT-OSS 120B             |
| `mistral-medium-3.1` | Mistral   | Mistral Medium (default) |
| `mistral-large-3`    | Mistral   | Mistral Large            |
| `sonnet-4.5`         | Anthropic | Claude Sonnet 4.5        |

---

## LLM Judge

The judge model is auto-detected based on available API keys:

| Priority | Condition               | Judge Model                |
| -------- | ----------------------- | -------------------------- |
| 1        | `ANTHROPIC_API_KEY` set | Claude Sonnet 4            |
| 2        | `OPENAI_API_KEY` set    | GPT-4o                     |
| 3        | Neither                 | gpt-oss-120b (via backend) |

Set API keys in `backend/.env`:

```bash
# Judge model API keys (choose one)
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...

# Langfuse connection (required for sync)
LANGFUSE_PUBLIC_KEY=pk-tb-eval-0000000000000000
LANGFUSE_SECRET_KEY=sk-tb-eval-0000000000000000
LANGFUSE_BASE_URL=http://localhost:3100
```

---

## Output Artifacts

Each evaluation produces two JSON files:

### `eval-results.json`

Promptfoo native format with all test results.

### `eval-summary.json`

Aggregate metrics with metadata:

```json
{
  "metadata": {
    "runId": "a1b2c3d4e5f6...",
    "timestamp": "2026-01-07T12:00:00.000Z",
    "git": {
      "sha": "abc123...",
      "branch": "main",
      "dirty": false
    },
    "model": "gpt-oss-120b",
    "judge": "anthropic:messages:claude-sonnet-4-20250514",
    "datasetHash": "xyz789..."
  },
  "results": {
    "total": 50,
    "passed": 45,
    "failed": 5,
    "passRate": 0.9,
    "avgScore": 0.85,
    "duration": 120
  }
}
```

---

## Langfuse Setup

Langfuse uses **headless initialization** - no manual UI clicks required.

### Default Credentials

| Field      | Value                       |
| ---------- | --------------------------- |
| URL        | http://localhost:3100       |
| Email      | eval@thunderbolt.local      |
| Password   | changeme123                 |
| Public Key | pk-tb-eval-0000000000000000 |
| Secret Key | sk-tb-eval-0000000000000000 |

### Docker Services

| Service         | Port | Purpose               |
| --------------- | ---- | --------------------- |
| langfuse-web    | 3100 | Main UI               |
| langfuse-worker | 3030 | Background processing |
| postgres        | 5432 | Metadata database     |
| clickhouse      | 8123 | Traces database       |
| redis           | 6379 | Queue                 |
| minio           | 9000 | S3-compatible storage |

### Start/Stop

```bash
# Start
bun run langfuse:up

# Stop
docker compose -f docker/langfuse/docker-compose.yml down

# Reset (clear all data)
docker compose -f docker/langfuse/docker-compose.yml down -v
```

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Evaluation

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * *' # Daily at 6am

jobs:
  evaluate:
    runs-on: ubuntu-latest
    services:
      # Langfuse services would go here
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1

      - run: bun install
        working-directory: backend

      - name: Start Langfuse
        run: |
          docker compose -f backend/docker/langfuse/docker-compose.yml up -d
          sleep 30  # Wait for initialization

      - name: Run Evaluation
        run: bun run eval --model gpt-oss-120b --no-cache
        working-directory: backend
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Sync to Langfuse
        run: bun run eval:sync
        working-directory: backend

      - name: Upload Results
        uses: actions/upload-artifact@v4
        with:
          name: eval-results
          path: |
            backend/src/evaluation/eval-results.json
            backend/src/evaluation/eval-summary.json
```

---

## Test Dataset

The dataset (`dataset.yaml`) contains ~50 test cases:

| Category   | Tests | Description                                   |
| ---------- | ----- | --------------------------------------------- |
| Tool Usage | 8     | Weather, search, news - MUST call tools       |
| Safety     | 5     | Harmful requests - MUST refuse                |
| Reasoning  | 6     | Math, logic - should NOT use tools            |
| Formatting | 5     | Lists, code, haiku                            |
| Language   | 5     | Spanish, French, German, Portuguese, Japanese |
| Factual    | 5     | History, science, geography                   |
| Context    | 3     | Ambiguity handling                            |
| Tone       | 4     | Greeting, empathy, professional               |
| Edge Cases | 3     | Empty input, gibberish                        |

Each test uses `llm-rubric` assertions with clear scoring criteria (0-1 range).

---

## File Structure

```
backend/
├── docker/
│   ├── langfuse/
│   │   └── docker-compose.yml    # Langfuse stack (6 services)
│   └── promptfoo/
│       └── docker-compose.yml    # Promptfoo UI only
├── scripts/
│   └── eval-and-sync.sh          # Combined eval + sync
├── src/
│   └── evaluation/
│       ├── promptfooconfig.yaml  # Promptfoo configuration
│       ├── dataset.yaml          # Test cases (~50)
│       ├── run.ts                # Evaluation runner
│       ├── sync-to-langfuse.ts   # One-way sync to Langfuse
│       ├── eval-results.json     # Output (gitignored)
│       ├── eval-summary.json     # Output (gitignored)
│       └── README.md             # This file
└── package.json                  # Scripts
```

---

## Troubleshooting

### "promptfoo: command not found"

```bash
bun add -g promptfoo
```

### Langfuse not starting

```bash
# Check logs
docker logs thunderbolt-langfuse-web

# Reset and restart
docker compose -f docker/langfuse/docker-compose.yml down -v
bun run langfuse:up
```

### Port conflicts

Default ports used:

- 3100: Langfuse UI
- 15500: Promptfoo view command (local)
- 15501: Promptfoo UI (Docker)

If conflicts exist, modify `docker-compose.yml` port mappings.

### Evaluation too slow

- Use `--no-cache` sparingly (forces fresh API calls)
- Check backend logs for rate limiting
- Consider reducing dataset size for iteration

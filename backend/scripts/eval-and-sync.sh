#!/bin/bash
# =============================================================================
# Thunderbolt Evaluation + Langfuse Sync
# =============================================================================
# Runs the full evaluation pipeline:
#   1. Execute Promptfoo evaluation
#   2. Sync results to Langfuse
#
# Usage:
#   ./scripts/eval-and-sync.sh --model gpt-oss-120b
#   ./scripts/eval-and-sync.sh --model mistral-medium-3.1 --no-cache
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"

cd "$BACKEND_DIR"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Thunderbolt Evaluation Pipeline"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Step 1: Run evaluation
echo "📊 Step 1: Running Promptfoo evaluation..."
echo ""
bun run eval "$@"

EVAL_EXIT=$?
if [ $EVAL_EXIT -ne 0 ]; then
    echo ""
    echo "❌ Evaluation failed with exit code $EVAL_EXIT"
    exit $EVAL_EXIT
fi

# Step 2: Sync to Langfuse
echo ""
echo "📤 Step 2: Syncing results to Langfuse..."
echo ""
bun run eval:sync

SYNC_EXIT=$?
if [ $SYNC_EXIT -ne 0 ]; then
    echo ""
    echo "⚠️  Sync failed with exit code $SYNC_EXIT"
    echo "   Results are still available in eval-results.json"
    exit $SYNC_EXIT
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Pipeline Complete"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  View results:"
echo "    - Langfuse: http://localhost:3100"
echo "    - Promptfoo: bun run eval:view"
echo ""


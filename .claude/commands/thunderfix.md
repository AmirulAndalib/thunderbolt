Fix all PR issues (review comments + CI failures) and monitor until clean.

A PR must already exist on the current branch.

## Setup

```bash
PR_NUMBER=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
```

If no PR is found, stop and tell the user.

## GraphQL Helper

All GraphQL queries use `$id` variables that conflict with shell expansion. Write queries to a temp file and load with `-F`:

```bash
GQL_DIR=$(mktemp -d)

cat > "$GQL_DIR/threads.graphql" << 'GQL'
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 10) { nodes { body path line author { login } } } }
      }
    }
  }
}
GQL

cat > "$GQL_DIR/threads_summary.graphql" << 'GQL'
query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved }
      }
    }
  }
}
GQL

cat > "$GQL_DIR/resolve.graphql" << 'GQL'
mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) {
    thread { id }
  }
}
GQL
```

## Fix Loop

Run this loop. Track elapsed time — stop after **15 minutes** total.

### 1. Fetch Issues

Gather all unresolved review comments and CI status:

```bash
PR_NODE_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.node_id')

UNRESOLVED=$(gh api graphql -F "query=@$GQL_DIR/threads.graphql" -f "id=$PR_NODE_ID" --jq '.data.node.reviewThreads.nodes[] | select(.isResolved == false)')

# CI status
gh pr checks "$PR_NUMBER"
```

### 2. Fix Review Comments

Read unresolved comments. Fix legitimate bugs and violations. Ignore style nits and false positives.

If fixes were made, push them:

```
Skill(skill="thunderpush")
```

If no issues were found (no unresolved comments, CI passing), skip to **Resolve Threads**.

### 3. Wait for CI

```bash
gh pr checks "$PR_NUMBER" --watch --fail-fast
```

If CI fails (max **3 CI fix attempts** per loop iteration):
1. Read failing logs:
   ```bash
   gh run list --branch "$(git branch --show-current)" --limit 1 --json databaseId --jq '.[0].databaseId' | xargs -I{} gh run view {} --log-failed
   ```
2. Fix the issue
3. Push: `Skill(skill="thunderpush")`
4. Wait for CI again

If CI still fails after 3 attempts, stop and report the failure.

### 4. Wait for New Review Comments

After CI passes, poll for new unresolved comments (max **5 minutes**, every 30s):

```bash
for i in $(seq 1 10); do
  NEW_UNRESOLVED=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" --jq '[.data.node.reviewThreads.nodes[] | select(.isResolved == false)] | length')

  if [ "$NEW_UNRESOLVED" -gt 0 ]; then
    break
  fi
  sleep 30
done
```

- If new unresolved comments found: **continue the loop** (back to step 1).
- If no new issues after 5 minutes: **break** — the PR is clean.

## Resolve Threads

After the loop exits, resolve all unresolved review threads:

```bash
THREAD_IDS=$(gh api graphql -F "query=@$GQL_DIR/threads_summary.graphql" -f "id=$PR_NODE_ID" --jq '.data.node.reviewThreads.nodes[] | select(.isResolved == false) | .id')

for THREAD_ID in $THREAD_IDS; do
  gh api graphql -F "query=@$GQL_DIR/resolve.graphql" -f "id=$THREAD_ID"
done

rm -rf "$GQL_DIR"
```

## Report

Print a summary:
- How many review comments were fixed
- How many CI failures were fixed
- Final CI status
- Whether the PR is clean

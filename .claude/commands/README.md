# thunderbot

Reusable [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills for development workflows. Use them as-is or customize them for your project.

## Install

### Option 1: Git subtree (recommended)

This maps the skills directly into your project's `.claude/commands/` directory. Edits flow both ways — you can push changes back upstream or pull community updates.

```bash
# Add thunderbot skills to your project
git subtree add --prefix=.claude/commands git@github.com:thunderbird/thunderbot.git main --squash

# Add a remote alias to simplify future commands
git remote add thunderbot git@github.com:thunderbird/thunderbot.git
```

**Pull upstream changes** (e.g. community PRs merged into thunderbot):

```bash
git subtree pull --prefix=.claude/commands thunderbot main --squash
```

**Push local skill edits back to thunderbot:**

```bash
git subtree push --prefix=.claude/commands thunderbot main
```

### Option 2: Manual copy

Copy individual `.md` files from this repo into your project's `.claude/commands/` directory.

## Customization

After installing, the skill files live in your project and are fully yours to edit. Customize them to match your project's tooling, conventions, and workflows.

If you make improvements that would benefit others, push them back upstream (see subtree commands above) or open a PR.

## Skills

| Skill | Description |
|-------|-------------|
| `thunderbot` | Autonomous coding agent for Linear tasks |
| `thunderbot-daemon` | Background daemon that polls Linear for tasks |
| `thundercheck` | Run type-checking, linting, and format-checking |
| `thunderclean` | Remove build artifacts |
| `thunderdoctor` | Verify dev tools and environment |
| `thunderdown` | Stop docker containers |
| `thunderfeedback` | Submit feedback as GitHub issues |
| `thunderfix` | Fix PR issues and monitor until clean |
| `thunderimprove` | Review changed code for quality |
| `thunderin` | Enter a work context (worktree, deps, bootstrap) |
| `thunderout` | Leave worktree and return to main |
| `thunderpush` | Stage, commit, and push changes |
| `thunderup` | Bootstrap the dev environment |

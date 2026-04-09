---
title: Configuration
description: Environment variables and configuration options.
---

Thunderbolt is configured via environment variables. Copy `.env.example` to `.env` and adjust as needed.

## Core Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_MODE` | Authentication mode (`local` or `oidc`) | `local` |
| `DATABASE_DRIVER` | Database driver (`sqlite` or `postgres`) | `sqlite` |
| `DATABASE_URL` | Database connection string | — |

## AI Provider Keys

Configure one or more AI providers:

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |

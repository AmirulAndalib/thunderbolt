# ACP Agent Architecture Plan

## Context

Thunderbolt currently uses Vercel AI SDK as its agent harness, tightly coupling the app to one way of running AI. The goal is to rearchitect around the Agent Client Protocol (ACP) so that the app can connect to:

- **Local CLI agents** (Claude Code, Codex, OpenClaw, Goose) running as subprocesses on desktop
- **A built-in agent** that works everywhere (browser, desktop, mobile) without requiring any CLI installation
- **Remote agents** (Haystack/Deepset pipelines, cloud-hosted agents) via HTTP/WebSocket

ACP is the right protocol — it's the "LSP for coding agents," created by Zed, adopted by Claude Code/Codex/Gemini/JetBrains, with TypeScript/Rust/Python SDKs. It uses JSON-RPC 2.0 over pluggable transports and its `Stream` type uses Web Streams API (`ReadableStream`/`WritableStream`), making it browser-compatible.

## Key Architectural Decisions

### 1. A chat belongs to one agent

ACP sessions are bound to a single agent connection. You cannot switch agents mid-session. A new agent means a new chat. This is clean and avoids complexity.

### 2. Modes and models are agent-declared, not global

ACP agents declare their capabilities at init time:
- **Modes** via `SessionModeState` — agent advertises `availableModes[]` and `currentModeId`
- **Models** via `SessionConfigOption` with `category: "model"` — agent advertises available models as a select dropdown

If an agent doesn't declare modes (e.g., a Haystack pipeline), the mode selector hides. If it doesn't declare models, the model selector hides. The UI is entirely driven by what the agent reports.

### 3. Three transport adapters

- **In-Process Stream** (all platforms): Uses `TransformStream` pairs to create an in-memory ACP connection. The built-in agent runs in the same JS context (or a Web Worker). This wraps the current `streamText` logic behind `AgentSideConnection`.
- **Stdio Stream** (desktop only): Uses Tauri's `Command` API to spawn CLI agents. Rust side manages the subprocess and bridges stdio to the frontend via Tauri IPC.
- **WebSocket Stream** (all platforms): For remote agents like Haystack or cloud-hosted agents.

### 4. Environment is not a separate selector

Environment (local/remote/in-process) is a property of the agent, not a user choice. Claude Code is always local stdio. The built-in agent is always in-process. Haystack is always remote. No environment dropdown needed.

### 5. Widgets remain a presentation-layer concern

ACP doesn't have a widget concept. The built-in agent continues to emit widget tags (`<widget:weather-forecast ... />`) in its text output, and the existing widget parser + renderer handles them. For ACP tool calls from external agents, we map `ToolCallContent` (text, diff, terminal) to the existing reasoning group / tool part UI.

## Data Model Changes

### New: `agents` table

```
agents
  id              TEXT PRIMARY KEY
  name            TEXT NOT NULL        -- "Claude Code", "Built-in", "Haystack Research"
  type            TEXT NOT NULL        -- "built-in" | "local" | "remote"
  transport       TEXT NOT NULL        -- "in-process" | "stdio" | "websocket"
  command         TEXT                 -- for local: "claude-code"
  args            TEXT                 -- for local: JSON array ["--acp"]
  url             TEXT                 -- for remote: "wss://..."
  authMethod      TEXT                 -- auth config if needed
  icon            TEXT                 -- lucide icon name
  isSystem        INTEGER DEFAULT 0   -- 1 = shipped with app / auto-discovered
  enabled         INTEGER DEFAULT 1
  deletedAt       TEXT                 -- soft delete
  userId          TEXT
  defaultHash     TEXT                 -- change detection for system agents
```

### Modified: `chat_threads` table

Add `agentId TEXT` column. Each chat is associated with one agent.

### Modified: `settings` table

Add `selected_agent` key. Replace `selected_model` and `selected_mode` — these become agent-scoped (stored on the ACP session, not globally).

### Remove: Direct dependency on `models` and `modes` tables for chat routing

Models and modes become agent-declared capabilities, not global app-level entities. The existing tables stay for the built-in agent's config, but other agents declare their own modes/models via ACP capability negotiation.

## Chat Store Changes

```typescript
type ChatSession = {
  id: string
  chatThread: ChatThread | null
  acpConnection: ClientSideConnection    // replaces chatInstance
  agentConfig: Agent                     // which agent this session uses
  availableModes: SessionMode[]          // from ACP capability negotiation
  currentModeId: string | null
  configOptions: SessionConfigOption[]   // includes model selector if agent supports it
  retryCount: number
  retriesExhausted: boolean
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  currentSessionId: string | null
  agents: Agent[]                        // replaces models[]
  sessions: Map<string, ChatSession>
  // modes[] and models[] removed — now per-agent
}
```

## UI Changes

### Agent Selector (replaces Model Selector in header)

- Uses the same `SearchableMenu` pattern as current model selector
- Groups: "Built-in", "Local" (auto-discovered), "Remote" (user-configured)
- Shows status indicators: connected/available/offline
- For local agents, grayed out with "Not installed" if CLI not found on PATH

### Mode Selector (stays, but dynamic)

- Same position and UI as current mode selector
- Options come from `session.availableModes` (ACP-declared), not from global `modes[]`
- Hidden entirely if agent declares no modes
- Calls `acpConnection.setSessionMode()` on change

### Model Selector (new, in prompt input area)

- Small selector next to mode selector in the prompt input footer
- Options come from `session.configOptions.find(o => o.category === 'model')`
- Hidden if agent has no model config option
- Calls `acpConnection.setSessionConfigOption()` on change

### Permission Dialog (new)

- Modal/sheet that appears when agent calls `session/request_permission`
- Shows the tool call info (title, kind, locations, diff preview)
- Buttons for each `PermissionOption` (allow once, allow always, reject)
- Returns selected option back via ACP response

### Tool Call Rendering (adapted)

Current rendering stays mostly the same. Map ACP tool updates to existing UI:

| ACP ToolKind | Current UI Equivalent |
|---|---|
| `read`, `search`, `fetch` | Reasoning group item with info icon |
| `edit`, `delete`, `move` | Reasoning group item + diff content block |
| `execute` | Reasoning group item with terminal output |
| `think` | Reasoning display (existing) |

ACP `ToolCallContent` types:
- `type: "content"` → render as text in expandable tool part
- `type: "diff"` → render inline diff (new component needed)
- `type: "terminal"` → render terminal output block

### Agent Thought Chunks

ACP streams `agent_thought_chunk` updates. Map these to the existing `reasoning` part type.

## Implementation Phases (Test-First)

### Phase 1: ACP Client Layer + In-Process Built-in Agent

**Goal**: Prove ACP works by wrapping the current AI SDK logic behind ACP, with zero user-visible changes.

**Tests first:**
- `src/acp/streams.test.ts` — in-process stream adapter creates valid bidirectional ACP streams
- `src/acp/built-in-agent.test.ts` — built-in agent handles initialize, newSession, prompt, cancel
- `src/acp/built-in-agent.test.ts` — built-in agent declares modes (chat/search/research) and models (from DB)
- `src/acp/built-in-agent.test.ts` — streaming text arrives as `agent_message_chunk` updates
- `src/acp/built-in-agent.test.ts` — tool calls reported as `tool_call` / `tool_call_update` events
- `src/acp/client.test.ts` — ACP client layer connects, initializes, creates session, sends prompt

**Implementation:**
- `src/acp/streams.ts` — `createInProcessStream()` using `TransformStream` pairs + `ndJsonStream`
- `src/acp/built-in-agent.ts` — `AgentSideConnection` handler that wraps `aiFetchStreamingResponse` logic (model creation, system prompt, tools, streaming)
- `src/acp/client.ts` — thin wrapper around `ClientSideConnection` with Thunderbolt-specific helpers
- `src/acp/types.ts` — shared types for agent config, session state

**Key files to modify:**
- `src/chats/chat-instance.ts` — replace `Chat` + `DefaultChatTransport` with ACP client connection
- `src/chats/chat-store.ts` — new session shape with ACP connection
- `src/chats/use-hydrate-chat-store.ts` — initialize ACP connection instead of Chat instance

**Verification**: All existing chat functionality works exactly as before. Existing tests still pass. New ACP tests pass.

### Phase 2: Agent Selector UI + Agent Registry

**Goal**: Replace model selector with agent selector. Auto-discover local agents on desktop.

**Tests first:**
- `src/dal/agents.test.ts` — CRUD operations for agents table
- `src/acp/discovery.test.ts` — discovers installed CLI agents (mocked `which` calls)
- `src/components/ui/agent-selector/agent-selector.test.tsx` — renders agents grouped by type, handles selection
- `src/chats/chat-store.test.ts` — `setSelectedAgent` creates new ACP connection

**Implementation:**
- DB migration: add `agents` table, add `agentId` to `chat_threads`
- `src/defaults/agents.ts` — default built-in agent config
- `src/dal/agents.ts` — DAL for agents
- `src/acp/discovery.ts` — detect installed CLI agents via Tauri shell
- `src/components/ui/agent-selector/agent-selector.tsx` — new component (reuse `SearchableMenu`)
- Modify `src/components/ui/header.tsx` — swap model selector for agent selector

**Key files to modify:**
- `src/db/tables.ts` — agents table schema
- `src/defaults/agents.ts` — system agents
- `src/components/ui/header.tsx` — agent selector instead of model selector
- `src/components/chat/chat-prompt-input.tsx` — dynamic mode/model selectors based on agent capabilities

**Verification**: Agent selector shows in header. Built-in agent selected by default. Mode/model selectors appear/hide based on agent capabilities.

### Phase 3: Local CLI Agents via Tauri

**Goal**: Connect to Claude Code, Codex, Goose etc. as ACP subprocess agents on desktop.

**Tests first:**
- `src/acp/stdio-stream.test.ts` — Tauri command bridge creates valid ACP stream (mocked Tauri API)
- `src/acp/local-agent.test.ts` — spawns agent process, initializes ACP, creates session
- `src/acp/local-agent.test.ts` — handles agent process exit gracefully
- `src/acp/permission-dialog.test.tsx` — renders permission options, returns selection

**Implementation:**
- `src/acp/stdio-stream.ts` — bridge Tauri `Command` stdio to Web Streams for ACP
- `src/acp/local-agent.ts` — lifecycle management for local agent processes
- `src/components/chat/permission-dialog.tsx` — permission request UI
- `src/components/chat/diff-block.tsx` — inline diff rendering for ACP diff content

**Key files to modify:**
- `src/components/chat/assistant-message.tsx` — handle ACP tool call content types (diff, terminal)
- `src/components/chat/reasoning-group.tsx` — map ACP ToolKind to existing icons/rendering
- `src/lib/assistant-message.ts` — adapt message part filtering for ACP content

**Verification**: With Claude Code installed, it appears in agent selector. Selecting it spawns the process. Can send prompts and receive streaming responses with tool calls and diffs rendered inline. Permission dialogs appear for sensitive operations.

### Phase 4: Remote Agents (WebSocket) + Haystack Migration

**Goal**: Connect to remote agents over WebSocket. Migrate Haystack from bespoke integration to ACP remote agent.

**Tests first:**
- `src/acp/websocket-stream.test.ts` — WebSocket adapter creates valid ACP stream (mocked WebSocket)
- `src/acp/remote-agent.test.ts` — connects to remote agent, handles reconnection
- `src/acp/haystack-agent.test.ts` — Haystack ACP wrapper handles doc search, citations, file downloads

**Implementation:**
- `src/acp/websocket-stream.ts` — WebSocket to ACP Stream adapter
- `src/acp/remote-agent.ts` — remote agent connection lifecycle (connect, reconnect, auth)
- Backend: `backend/src/haystack/acp-adapter.ts` — wraps Haystack API behind ACP server interface
- `src/settings/agents/index.tsx` — settings page for adding/configuring remote agents

**Key files to modify:**
- `src/chats/chat-instance.ts` — remove Haystack-specific routing (now handled by agent selection)
- `src/ai/haystack-fetch.ts` — internals reused inside the ACP adapter
- `src/defaults/modes.ts` — remove `defaultModeDocSearch` (becomes a Haystack agent mode)

**Verification**: Can add a remote Haystack agent in settings. Selecting it in agent selector connects over WebSocket. Document search works with citations rendering correctly.

### Phase 5: Cleanup + Remove Legacy AI SDK Path

**Goal**: Remove all direct Vercel AI SDK usage from the chat flow. Everything goes through ACP.

**Tests first:**
- Integration tests verifying all agent types work end-to-end
- Regression tests for existing functionality (widgets, citations, tool calls, retry logic)

**Implementation:**
- Remove `Chat` class usage from `@ai-sdk/react` (ACP handles the conversation loop)
- Remove `DefaultChatTransport` and custom fetch pattern
- Remove `aiFetchStreamingResponse` as a direct entry point (it lives inside the built-in agent now)
- Clean up unused imports, types, and dead code
- Update `package.json` — can likely remove `@ai-sdk/react` (keep `ai` core for `streamText` inside built-in agent)

**Key files to modify:**
- `src/chats/chat-instance.ts` — simplify to just ACP connection creation
- `src/chats/chat-store.ts` — remove `models[]`, `modes[]`, `mcpClients[]` from top-level state
- `src/types.ts` — remove `ThunderboltUIMessage` dependency on AI SDK `UIMessage` type

**Verification**: Full test suite passes. No direct AI SDK imports in chat flow. All three agent types (built-in, local, remote) work. Existing features (widgets, citations, tool calls, retry, automations) all function correctly.

## Dependencies

- `@agentclientprotocol/sdk` — ACP TypeScript SDK (client + agent side)
- Keep `ai` (Vercel AI SDK core) — used internally by built-in agent for `streamText`
- Keep `@ai-sdk/anthropic`, `@ai-sdk/openai`, etc. — used by built-in agent's model creation
- Can eventually remove `@ai-sdk/react` — ACP replaces the chat transport layer

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ACP SDK doesn't work in browser | `Stream` uses Web Streams API which is browser-native. `ndJsonStream` accepts any `ReadableStream`/`WritableStream`. Verified in spec. |
| Streaming latency through ACP layer | Phase 1 validates this. In-process stream is effectively zero-copy. If latency is unacceptable, we can optimize the JSON-RPC serialization. |
| Tool call rendering fidelity | ACP tool calls are richer than current (diffs, terminal, locations). This is additive, not lossy. Current tool rendering stays, new capabilities layered on. |
| Widget system breaks | Widgets are text-level parsing, orthogonal to ACP. Built-in agent still emits widget tags. External agents won't use widgets (they use ACP content blocks instead). |
| Haystack migration complexity | Citations/doc widgets need to map to ACP content somehow. Could use ACP's extensibility (`_meta` fields) or custom content blocks. May need a custom Thunderbolt ACP extension. |

## References

- [Agent Client Protocol spec](https://agentclientprotocol.com/)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP AI SDK community provider](https://ai-sdk.dev/providers/community-providers/acp)
- [Claude Code via ACP in Zed](https://zed.dev/blog/claude-code-via-acp)
- [claude-agent-acp adapter](https://github.com/zed-industries/claude-agent-acp)
- [Claude Agent SDK (npm)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [ACP ClientSideConnection API](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html)

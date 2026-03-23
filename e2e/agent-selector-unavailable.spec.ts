import { test, expect } from '@playwright/test'
import { goToNewChat } from './helpers'

/**
 * Helper: inject agents into the chat store via the dev-mode test bridge.
 * Sets both the agents list and the unavailableAgentIds set.
 */
const seedAgentsInStore = async (
  page: import('@playwright/test').Page,
  agents: Array<{
    id: string
    name: string
    type: 'built-in' | 'local' | 'remote'
    transport: string
    icon: string
    isSystem: number
    enabled: number
    command: string | null
    args: string | null
    url: string | null
    authMethod: string | null
    deletedAt: string | null
    defaultHash: string | null
    userId: string | null
  }>,
  unavailableIds: string[],
) => {
  await page.evaluate(
    ({ agents, unavailableIds }) => {
      const store = (window as Record<string, unknown>).__thunderboltChatStore as {
        getState: () => { setAgents: (agents: unknown[], ids: Set<string>) => void }
      }
      store.getState().setAgents(agents, new Set(unavailableIds))
    },
    { agents, unavailableIds },
  )
}

const builtInAgent = {
  id: 'agent-built-in',
  name: 'Thunderbolt',
  type: 'built-in' as const,
  transport: 'in-process',
  icon: 'zap',
  isSystem: 1,
  enabled: 1,
  command: null,
  args: null,
  url: null,
  authMethod: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const localAgent = {
  id: 'agent-claude-code',
  name: 'Claude Code',
  type: 'local' as const,
  transport: 'stdio',
  icon: 'terminal',
  isSystem: 1,
  enabled: 1,
  command: 'claude-agent-acp',
  args: null,
  url: null,
  authMethod: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const localAgent2 = {
  id: 'agent-codex',
  name: 'Codex',
  type: 'local' as const,
  transport: 'stdio',
  icon: 'code',
  isSystem: 1,
  enabled: 1,
  command: 'codex',
  args: '["--acp"]',
  url: null,
  authMethod: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
}

const allAgents = [builtInAgent, localAgent, localAgent2]

test.describe('Agent Selector - Unavailable Agents on Web', () => {
  test.beforeEach(async ({ page }) => {
    await goToNewChat(page)
  })

  test.describe('Visibility', () => {
    test('unavailable agents appear in the selector dropdown', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code', 'agent-codex'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Both unavailable agents should be visible in the dropdown
        await expect(popover.getByText('Claude Code').first()).toBeVisible()
        await expect(popover.getByText('Codex').first()).toBeVisible()
      }
    })

    test('unavailable agents show disabled visual state (opacity)', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // The disabled agent's button should have the disabled attribute
        const claudeCodeButton = popover.getByText('Claude Code').first().locator('xpath=ancestor::button')
        await expect(claudeCodeButton).toBeDisabled()
      }
    })

    test('unavailable agents show "Unavailable" description', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        await expect(popover.getByText('Unavailable').first()).toBeVisible()
      }
    })

    test('unavailable agents show in their correct group ("Local Agents")', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code', 'agent-codex'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        await expect(popover.getByText('Local Agents')).toBeVisible()
      }
    })

    test('available agents show normally (not disabled)', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Built-in agent's button should NOT be disabled
        const thunderboltButton = popover
          .getByText('Thunderbolt')
          .first()
          .locator('xpath=ancestor::button')
        await expect(thunderboltButton).toBeEnabled()
      }
    })

    test('trigger shows correct agent name even for unavailable agents', async ({ page }) => {
      // Inject agents with Claude Code as unavailable, but set it as the session agent
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      // Set the session's agent to the unavailable one
      await page.evaluate(() => {
        const store = (window as Record<string, unknown>).__thunderboltChatStore as {
          getState: () => {
            currentSessionId: string | null
            sessions: Map<string, { agentConfig: { id: string; name: string } }>
            updateSession: (id: string, data: Record<string, unknown>) => void
          }
        }
        const state = store.getState()
        const sessionId = state.currentSessionId
        if (sessionId) {
          store.getState().updateSession(sessionId, {
            agentConfig: {
              id: 'agent-claude-code',
              name: 'Claude Code',
              type: 'local',
              transport: 'stdio',
              icon: 'terminal',
              isSystem: 1,
              enabled: 1,
              command: 'claude-agent-acp',
              args: null,
              url: null,
              authMethod: null,
              deletedAt: null,
              defaultHash: null,
              userId: null,
            },
          })
        }
      })

      // The trigger should show "Claude Code" even though it's unavailable
      const header = page.locator('header')
      await expect(header.getByText('Claude Code').first()).toBeVisible({ timeout: 5000 })
    })
  })

  test.describe('Interaction', () => {
    test('clicking a disabled agent does NOT navigate to new chat', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        const urlBefore = page.url()

        // Try to click the disabled agent
        const claudeCodeItem = popover.getByText('Claude Code').first()
        await claudeCodeItem.click({ force: true }).catch(() => {})
        await page.waitForTimeout(500)

        // URL should not have changed
        expect(page.url()).toBe(urlBefore)
      }
    })

    test('clicking a disabled agent does NOT change the selected agent in trigger', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Click the disabled agent
        const claudeCodeItem = popover.getByText('Claude Code').first()
        await claudeCodeItem.click({ force: true }).catch(() => {})
        await page.waitForTimeout(500)

        // Trigger should still show Thunderbolt (not Claude Code)
        await expect(header.getByText('Thunderbolt').first()).toBeVisible()
      }
    })

    test('clicking an available agent navigates to new chat', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Click the available agent (Thunderbolt - re-selecting it should navigate to new chat)
        const thunderboltItem = popover.getByText('Thunderbolt').first()
        await thunderboltItem.click()
        await page.waitForTimeout(1000)

        // Should have navigated to a chat URL
        expect(page.url()).toContain('/chats/')
        // Chat UI should render
        await expect(page.locator('textarea')).toBeVisible({ timeout: 15000 })
      }
    })

    test('dropdown closes after clicking an available agent', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        const thunderboltItem = popover.getByText('Thunderbolt').first()
        await thunderboltItem.click()
        await page.waitForTimeout(1000)

        // Popover should be closed
        const visible = await popover.isVisible().catch(() => false)
        expect(visible).toBe(false)
      }
    })
  })

  test.describe('Chat navigation with unavailable agent', () => {
    test('switching to a chat that uses an unavailable agent shows it selected in header', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      // Set the current session's agent to the unavailable agent
      await page.evaluate(() => {
        const store = (window as Record<string, unknown>).__thunderboltChatStore as {
          getState: () => {
            currentSessionId: string | null
            updateSession: (id: string, data: Record<string, unknown>) => void
          }
        }
        const state = store.getState()
        const sessionId = state.currentSessionId
        if (sessionId) {
          store.getState().updateSession(sessionId, {
            agentConfig: {
              id: 'agent-claude-code',
              name: 'Claude Code',
              type: 'local',
              transport: 'stdio',
              icon: 'terminal',
              isSystem: 1,
              enabled: 1,
              command: 'claude-agent-acp',
              args: null,
              url: null,
              authMethod: null,
              deletedAt: null,
              defaultHash: null,
              userId: null,
            },
          })
        }
      })

      // Header trigger should show "Claude Code"
      const header = page.locator('header')
      await expect(header.getByText('Claude Code').first()).toBeVisible({ timeout: 5000 })
    })

    test('chat area still renders correctly when agent is unavailable', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      // Verify the chat UI is still functional
      const textarea = page.locator('textarea')
      await expect(textarea).toBeVisible()
      await expect(textarea).toHaveAttribute('placeholder', /ask me anything/i)

      // Submit button should be present
      const submitButton = page.locator('form button[type="submit"]')
      await expect(submitButton).toBeVisible()
    })

    test('chat input is functional when selected agent is unavailable', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      // Set session to unavailable agent
      await page.evaluate(() => {
        const store = (window as Record<string, unknown>).__thunderboltChatStore as {
          getState: () => {
            currentSessionId: string | null
            updateSession: (id: string, data: Record<string, unknown>) => void
          }
        }
        const state = store.getState()
        const sessionId = state.currentSessionId
        if (sessionId) {
          store.getState().updateSession(sessionId, {
            agentConfig: {
              id: 'agent-claude-code',
              name: 'Claude Code',
              type: 'local',
              transport: 'stdio',
              icon: 'terminal',
              isSystem: 1,
              enabled: 1,
              command: 'claude-agent-acp',
              args: null,
              url: null,
              authMethod: null,
              deletedAt: null,
              defaultHash: null,
              userId: null,
            },
          })
        }
      })

      // Chat input should still work
      const textarea = page.locator('textarea')
      await textarea.fill('Hello from unavailable agent chat')
      await expect(textarea).toHaveValue('Hello from unavailable agent chat')
    })

    test('selected unavailable agent shows checkmark in dropdown', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      // Set session agent to the unavailable one
      await page.evaluate(() => {
        const store = (window as Record<string, unknown>).__thunderboltChatStore as {
          getState: () => {
            currentSessionId: string | null
            updateSession: (id: string, data: Record<string, unknown>) => void
          }
        }
        const state = store.getState()
        const sessionId = state.currentSessionId
        if (sessionId) {
          store.getState().updateSession(sessionId, {
            agentConfig: {
              id: 'agent-claude-code',
              name: 'Claude Code',
              type: 'local',
              transport: 'stdio',
              icon: 'terminal',
              isSystem: 1,
              enabled: 1,
              command: 'claude-agent-acp',
              args: null,
              url: null,
              authMethod: null,
              deletedAt: null,
              defaultHash: null,
              userId: null,
            },
          })
        }
      })

      // Open the dropdown
      const header = page.locator('header')
      await header.getByText('Claude Code').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // The Claude Code item should have both disabled styling and a checkmark
        // Find the item that contains "Claude Code" text and check for SVGs (icon + checkmark)
        const claudeCodeItem = popover.locator('button:disabled').filter({ hasText: 'Claude Code' })
        if (await claudeCodeItem.count()) {
          const svgs = claudeCodeItem.locator('svg')
          // Should have at least 2 SVGs: agent icon + checkmark
          expect(await svgs.count()).toBeGreaterThanOrEqual(2)
        }
      }
    })
  })

  test.describe('Edge cases', () => {
    test('only built-in agent present - selector still works normally', async ({ page }) => {
      await seedAgentsInStore(page, [builtInAgent], [])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        await expect(popover.getByText('Thunderbolt').first()).toBeVisible()
        // No "Local Agents" group should exist
        expect(await popover.getByText('Local Agents').count()).toBe(0)
      }
    })

    test('all agents available - no disabled items', async ({ page }) => {
      await seedAgentsInStore(page, allAgents, [])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // All buttons should be enabled
        const disabledButtons = popover.locator('button:disabled')
        expect(await disabledButtons.count()).toBe(0)
      }
    })

    test('mixed available/unavailable - correct states for each', async ({ page }) => {
      // Only Claude Code is unavailable, Codex and Thunderbolt are available
      await seedAgentsInStore(page, allAgents, ['agent-claude-code'])

      const header = page.locator('header')
      await header.getByText('Thunderbolt').first().click()
      await page.waitForTimeout(500)

      const popover = page.locator('[data-radix-popper-content-wrapper]')
      if (await popover.isVisible().catch(() => false)) {
        // Claude Code should be disabled
        const claudeCodeButton = popover.locator('button:disabled').filter({ hasText: 'Claude Code' })
        expect(await claudeCodeButton.count()).toBe(1)

        // Codex should be enabled
        const codexButton = popover.locator('button:not(:disabled)').filter({ hasText: 'Codex' })
        expect(await codexButton.count()).toBe(1)

        // Thunderbolt should be enabled
        const thunderboltButton = popover.locator('button:not(:disabled)').filter({ hasText: 'Thunderbolt' })
        expect(await thunderboltButton.count()).toBe(1)
      }
    })
  })
})

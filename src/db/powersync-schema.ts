import { DrizzleAppSchema } from '@powersync/drizzle-driver'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelsTable,
  promptsTable,
  settingsTable,
  tasksTable,
  triggersTable,
} from './tables'

/**
 * Drizzle schema object containing all tables for PowerSync.
 * PowerSync creates views for these tables based on its JSON-based internal storage.
 */
export const drizzleSchema = {
  settings: settingsTable,
  chatThreads: chatThreadsTable,
  chatMessages: chatMessagesTable,
  tasks: tasksTable,
  models: modelsTable,
  mcpServers: mcpServersTable,
  prompts: promptsTable,
  triggers: triggersTable,
}

/**
 * PowerSync schema generated from the Drizzle schema.
 * This ensures the PowerSync and Drizzle schemas stay in sync.
 */
export const PowerSyncAppSchema = new DrizzleAppSchema(drizzleSchema)

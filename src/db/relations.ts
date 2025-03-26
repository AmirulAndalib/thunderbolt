import { relations } from 'drizzle-orm'
import { chatMessagesTable, chatThreadsTable, emailMessagesTable, emailThreadsTable, embeddingsTable, todosTable } from './schema'

export const chatThreadsRelations = relations(chatThreadsTable, ({ many }) => ({
  messages: many(chatMessagesTable),
}))

export const chatMessagesRelations = relations(chatMessagesTable, ({ one }) => ({
  thread: one(chatThreadsTable, {
    fields: [chatMessagesTable.chat_thread_id],
    references: [chatThreadsTable.id],
  }),
}))

export const embeddingsRelations = relations(embeddingsTable, ({ one }) => ({
  emailMessage: one(emailMessagesTable, {
    fields: [embeddingsTable.email_message_id],
    references: [emailMessagesTable.id],
  }),
  emailThread: one(emailThreadsTable, {
    fields: [embeddingsTable.email_thread_id],
    references: [emailThreadsTable.id],
  }),
}))

export const emailMessagesRelations = relations(emailMessagesTable, ({ one }) => ({
  embedding: one(embeddingsTable, {
    fields: [emailMessagesTable.id],
    references: [embeddingsTable.email_message_id],
  }),
  thread: one(emailThreadsTable, {
    fields: [emailMessagesTable.email_thread_id],
    references: [emailThreadsTable.id],
  }),
}))

export const emailThreadsRelations = relations(emailThreadsTable, ({ many, one }) => ({
  messages: many(emailMessagesTable),
  embedding: one(embeddingsTable, {
    fields: [emailThreadsTable.id],
    references: [embeddingsTable.email_thread_id],
  }),
  todos: many(todosTable),
}))

export const todosRelations = relations(todosTable, ({ one }) => ({
  emailThread: one(emailThreadsTable, {
    fields: [todosTable.email_thread_id],
    references: [emailThreadsTable.id],
  }),
}))

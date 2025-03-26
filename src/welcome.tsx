import { useSettings } from '@/settings/provider'
import { createOpenAI } from '@ai-sdk/openai'
import { streamObject } from 'ai'
import { isNotNull } from 'drizzle-orm'
import { Calendar, CheckCircle2, ChevronDown, Mail, MessageSquare, RefreshCw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { Button } from './components/ui/button'
import { Skeleton } from './components/ui/skeleton'
import { useDrizzle } from './db/provider'
import { todosTable } from './db/schema'
import { useImap } from './imap/provider'
import { getFromFromParsedEmail, getMessageIdFromParsedEmail } from './lib/utils'

export default function WelcomePage() {
  const settingsContext = useSettings()
  const { client: imapClient } = useImap()
  const { db } = useDrizzle()
  const [_inboxSummary, setInboxSummary] = useState<string | null>(null)
  const [toDoList, setToDoList] = useState<{ item: string; imap_id: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showAllTodos, setShowAllTodos] = useState(false)

  const hours = new Date().getHours()
  const timeOfDay = hours < 12 ? 'Morning' : hours < 18 ? 'Afternoon' : 'Evening'
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const fetchInboxData = async (forceRefresh = false) => {
    try {
      if (!imapClient) return

      setIsRefreshing(true)
      setLoading(true)
      setToDoList([]) // Clear existing todos while loading

      // Check if we need to regenerate todos
      const lastGeneratedTodos = settingsContext.settings?.last_generated_todos_from_inbox
      const now = new Date().getTime()
      const oneHourInMs = 60 * 60 * 1000

      // If lastGeneratedTodos is more than 1 hour old or doesn't exist, or if forceRefresh is true, regenerate todos
      if (forceRefresh || !lastGeneratedTodos || now - parseInt(lastGeneratedTodos) > oneHourInMs) {
        console.log('Regenerating todos')

        // Delete existing todos with email_thread_id
        await db.delete(todosTable).where(isNotNull(todosTable.imap_id))

        // Fetch emails from inbox
        const inboxEmails = await imapClient.fetchInbox('INBOX', undefined, 10)

        // Get API key from settings
        const apiKey = settingsContext?.settings?.models?.openai_api_key

        if (!apiKey) {
          setInboxSummary('Please set your OpenAI API key in settings to generate inbox summaries.')
          setLoading(false)
          setIsRefreshing(false)
          return
        }

        const openai = createOpenAI({
          apiKey,
        })

        // Create a prompt for summarizing the inbox
        const emailsContext = inboxEmails
          .map(
            (email) =>
              `IMAP ID: ${getMessageIdFromParsedEmail(email)}\nSubject: ${email.subject || 'No subject'}\nFrom: ${getFromFromParsedEmail(email) || 'Unknown'}\nSnippet: ${
                email.snippet || email.clean_text?.substring(0, 300) || 'No content'
              }`
          )
          .join('\n\n')

        const result = streamObject({
          model: openai('o3-mini'),
          system: `You are an email assistant that turns emails into a to-do list. Provide up to 10 to-do items based on the emails provided while ensuring that you never duplicate items. Only include items that are appear important and actionable. Ignore items that appear to be newsletters, informational, solicitation, or promotional. If you reference a person, use their full name (the user might not know who they are). Assume the user has not read the emails and doesn't know anything about them or the people, places, or ideas mentioned in them. Don't refer to "the ___" (the user might not know what that is) - only refer to things by name. Keep each line under 100 characters.`,
          messages: [
            {
              role: 'user',
              content: `Here are the latest emails in my inbox. Please provide a summary:\n\n${emailsContext}`,
            },
          ],
          output: 'array',
          schema: z.object({
            imap_id: z.string(),
            item: z.string(),
          }),
          onError(error) {
            console.error('Error fetching inbox data:', error)
            setInboxSummary('Error loading inbox summary. Please try again later.')
            setLoading(false)
            setIsRefreshing(false)
          },
          onFinish(_response) {
            console.log('response', _response)
          },
        })

        for await (const partialObject of result.partialObjectStream) {
          setLoading(false)
          setToDoList((_prev) => partialObject)
        }

        // Insert todos into the database
        for (const todo of await result.object) {
          await db.insert(todosTable).values({
            id: uuidv7(),
            item: todo.item,
            imap_id: todo.imap_id,
          })
        }

        // Save the timestamp of when we generated the todos
        await settingsContext.setSettings({
          ...settingsContext.settings,
          last_generated_todos_from_inbox: now.toString(),
        })
      } else {
        // If we don't need to regenerate todos, just fetch them from the database
        const todos = await db.select().from(todosTable).orderBy(todosTable.id)
        setToDoList(todos.map((todo) => ({ item: todo.item, imap_id: todo.imap_id })))
        setLoading(false)
      }

      setLoading(false)
      setIsRefreshing(false)
    } catch (error) {
      console.error('Error fetching inbox data:', error)
      setInboxSummary('Error loading inbox summary. Please try again later.')
      setLoading(false)
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    fetchInboxData()
  }, [])

  const displayedTodos = showAllTodos ? toDoList : toDoList.slice(0, 3)

  return (
    <div className="h-full w-full p-8 flex flex-col gap-6 bg-gradient-to-br from-background to-secondary/20">
      <div className="max-w-4xl mx-auto w-full">
        <h1 className="text-4xl font-bold tracking-tight mb-2 text-primary">
          Good {timeOfDay}, <span className="text-primary">Chris</span>
        </h1>
        <p className="text-muted-foreground text-lg">{date}</p>

        {/* To-Do List Section */}
        <div className="mt-6 bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <CheckCircle2 className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Your Action Items</h2>
            </div>
            <Button variant="ghost" size="icon" onClick={() => fetchInboxData(true)} className="cursor-pointer" disabled={isRefreshing}>
              <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <div className="space-y-4">
            {loading ? (
              <>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-5 w-[180px]" />
                  <Skeleton className="h-5 w-[80px]" />
                </div>
                <div className="space-y-3 mt-4">
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                {displayedTodos.length > 0 ? (
                  <>
                    {displayedTodos.map((todo, index) => (
                      <div
                        key={index}
                        className="p-4 bg-secondary/10 hover:bg-secondary/80 rounded-lg flex items-start gap-3 cursor-pointer transition-colors group"
                        onClick={() => console.log(`Todo clicked: ${todo.imap_id}`)}
                      >
                        <Square className="h-5 w-5 text-primary flex-shrink-0 mt-0.5 group-hover:text-primary/80 transition-colors" />
                        <div className="flex-1">
                          <span className="text-sm font-medium">{todo.item}</span>
                        </div>
                      </div>
                    ))}
                    {toDoList.length > 3 && !showAllTodos && (
                      <Button variant="ghost" className="w-full mt-4 flex items-center justify-center gap-2" onClick={() => setShowAllTodos(true)}>
                        Show More <ChevronDown className="h-4 w-4" />
                      </Button>
                    )}
                    {showAllTodos && (
                      <Button variant="ghost" className="w-full mt-4 flex items-center justify-center gap-2" onClick={() => setShowAllTodos(false)}>
                        Show Less <ChevronDown className="h-4 w-4 rotate-180" />
                      </Button>
                    )}
                  </>
                ) : (
                  <div className="text-center py-6 text-muted-foreground flex flex-col items-center gap-2">
                    <CheckCircle2 className="h-8 w-8 text-primary/40" />
                    <span>No urgent tasks from your inbox. Enjoy your day!</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Inbox Summary Section - Commented out for later
        <div className="mt-6 bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
          <div className="flex items-center gap-4 mb-4">
            <div className="bg-primary/10 p-3 rounded-full">
              <Inbox className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-xl font-semibold">Inbox Summary</h2>
          </div>
          <div className="space-y-4">
            {loading ? (
              <>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-5 w-[180px]" />
                  <Skeleton className="h-5 w-[80px]" />
                </div>
                <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                  <Skeleton className="h-full w-[65%]" />
                </div>
                <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="bg-secondary/30 p-4 rounded-md">
                    <Skeleton className="h-4 w-[60%] mb-2" />
                    <Skeleton className="h-6 w-[40%]" />
                  </div>
                  <div className="bg-secondary/30 p-4 rounded-md">
                    <Skeleton className="h-4 w-[70%] mb-2" />
                    <Skeleton className="h-6 w-[50%]" />
                  </div>
                  <div className="bg-secondary/30 p-4 rounded-md">
                    <Skeleton className="h-4 w-[80%] mb-2" />
                    <Skeleton className="h-6 w-[45%]" />
                  </div>
                </div>
                <div className="space-y-3 mt-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-[92%]" />
                  <Skeleton className="h-4 w-[85%]" />
                </div>
              </>
            ) : (
              <div className="prose prose-sm dark:prose-invert">{inboxSummary || 'No inbox summary available.'}</div>
            )}
          </div>
        </div>
        */}

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <Mail className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Recent Emails</h2>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[85%]" />
              <Skeleton className="h-4 w-[70%]" />
            </div>
          </div>

          <div className="bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <Calendar className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Today's Schedule</h2>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[90%]" />
              <Skeleton className="h-4 w-[75%]" />
            </div>
          </div>

          <div className="bg-card rounded-lg shadow-sm p-6 border border-border hover:border-primary/20 transition-all hover:shadow-md">
            <div className="flex items-center gap-4 mb-4">
              <div className="bg-primary/10 p-3 rounded-full">
                <MessageSquare className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-semibold">Recent Chats</h2>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[80%]" />
              <Skeleton className="h-4 w-[65%]" />
            </div>
          </div>
        </div>

        <div className="mt-8 bg-card rounded-lg shadow-sm p-6 border border-border">
          <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">New Chat</span>
            </button>
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">Check Email</span>
            </button>
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">Settings</span>
            </button>
            <button className="p-4 bg-primary/5 hover:bg-primary/10 rounded-md flex flex-col items-center justify-center transition-colors">
              <span className="text-sm font-medium">Help</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

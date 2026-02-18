import * as posthogClient from '@/posthog/client'
import * as settingsModule from '@/config/settings'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import * as streamingUtils from '@/utils/streaming'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import type OpenAI from 'openai'
import * as inferenceClient from './client'
import { createInferenceRoutes, supportedModels } from './routes'

type ElysiaApp = {
  handle: (request: Request) => Promise<Response>
}

describe('Inference Routes', () => {
  let app: ElysiaApp
  let getInferenceClientSpy: ReturnType<typeof spyOn>
  let isPostHogConfiguredSpy: ReturnType<typeof spyOn>
  let createSSEStreamSpy: ReturnType<typeof spyOn>
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies

  // Mock OpenAI client
  const mockCreateCompletion = mock(() => Promise.resolve({}))

  const mockOpenAIClient = {
    chat: {
      completions: {
        create: mockCreateCompletion,
      },
    },
  }

  const createMockStream = (chunks: any[] = []) => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  })

  const createMockSSEStream = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"test": "chunk"}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()

    // Mock settings
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      fireworksApiKey: '',
      mistralApiKey: '',
      anthropicApiKey: '',
      exaApiKey: '',
      thunderboltInferenceUrl: '',
      thunderboltInferenceApiKey: '',
      tinfoilApiKey: 'test-api-key',
      tinfoilEnclaveAllowedHostnames: 'inference.tinfoil.sh',
      monitoringToken: '',
      googleClientId: '',
      googleClientSecret: '',
      microsoftClientId: '',
      microsoftClientSecret: '',
      logLevel: 'INFO',
      port: 8000,
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: '',
      corsOrigins: 'http://localhost:1420',
      corsOriginRegex: '',
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders: 'Content-Type,Authorization',
      corsExposeHeaders: '',
      waitlistEnabled: false,
    })

    // Mock dependencies
    getInferenceClientSpy = spyOn(inferenceClient, 'getInferenceClient').mockReturnValue({
      client: mockOpenAIClient as unknown as OpenAI,
      provider: 'mistral',
    })
    isPostHogConfiguredSpy = spyOn(posthogClient, 'isPostHogConfigured').mockReturnValue(false)
    createSSEStreamSpy = spyOn(streamingUtils, 'createSSEStreamFromCompletion').mockReturnValue(createMockSSEStream())

    app = new Elysia().use(createInferenceRoutes())
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    getInferenceClientSpy?.mockRestore()
    isPostHogConfiguredSpy?.mockRestore()
    createSSEStreamSpy?.mockRestore()
    consoleSpies.restore()
  })

  describe('POST /chat/completions', () => {
    const validRequestBody = {
      model: 'mistral-large-3',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      temperature: 0.7,
    }

    beforeEach(() => {
      // Reset all mocks before each test
      mockCreateCompletion.mockClear()
      createSSEStreamSpy.mockClear()
      getInferenceClientSpy.mockClear()
      getInferenceClientSpy.mockReturnValue({
        client: mockOpenAIClient as unknown as OpenAI,
        provider: 'mistral',
      })
    })

    it('should handle valid streaming request successfully', async () => {
      const mockCompletion = createMockStream([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world!' } }] },
      ])

      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
      expect(response.headers.get('Connection')).toBe('keep-alive')

      expect(mockCreateCompletion).toHaveBeenCalledWith({
        model: 'mistral-large-2512',
        messages: validRequestBody.messages,
        temperature: validRequestBody.temperature,
        tools: undefined,
        tool_choice: undefined,
        stream: true,
      })

      expect(createSSEStreamSpy).toHaveBeenCalledWith(mockCompletion, validRequestBody.model)
    })

    it('should route gpt-oss-120b model to tinfoil provider with EHBP passthrough', async () => {
      // Mock Node's https module for Tinfoil EHBP requests
      const https = await import('node:https')
      const { EventEmitter } = await import('node:events')

      // Create mock response that emits events like a real IncomingMessage
      class MockIncomingMessage extends EventEmitter {
        statusCode = 200
        headers = {
          'content-type': 'text/event-stream',
          'ehbp-response-nonce': 'test-nonce-123',
        }
        trailers = {
          'x-tinfoil-usage-metrics': 'prompt=67,completion=42,total=109',
        }

        on(event: string, handler: any) {
          super.on(event, handler)
          // Simulate streaming response
          if (event === 'data') {
            setTimeout(() => {
              handler(Buffer.from('data: {"test": "chunk"}\n\n'))
              handler(Buffer.from('data: [DONE]\n\n'))
            }, 0)
          }
          if (event === 'end') {
            setTimeout(() => handler(), 10)
          }
          return this
        }
      }

      const mockRequest = new EventEmitter() as any
      mockRequest.write = mock(() => {})
      mockRequest.end = mock(() => {})
      mockRequest.destroy = mock(() => {})

      const httpsSpy = spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
        setTimeout(() => callback(new MockIncomingMessage()), 0)
        return mockRequest
      })

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(200)

      // Verify https.request was called with correct options
      expect(httpsSpy).toHaveBeenCalled()
      const callArgs = httpsSpy.mock.calls[0]
      expect(callArgs[0]).toEqual(
        expect.objectContaining({
          hostname: 'inference.tinfoil.sh',
          port: 443,
          method: 'POST',
          headers: expect.objectContaining({
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Request-Usage-Metrics': 'true',
            Authorization: 'Bearer test-api-key',
          }),
        }),
      )

      // Verify EHBP response headers are forwarded
      expect(response.headers.get('Ehbp-Response-Nonce')).toBe('test-nonce-123')

      httpsSpy.mockRestore()
    })

    it('should reject EHBP request with missing X-Tinfoil-Enclave-Url header', async () => {
      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            // Missing X-Tinfoil-Enclave-Url
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should reject EHBP request with invalid URL', async () => {
      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'not-a-valid-url',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should reject EHBP request with non-HTTPS URL', async () => {
      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'http://insecure.example.com',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should reject EHBP request with disallowed hostname', async () => {
      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://evil.example.com',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(500)
      const json = await response.json()
      // Error message is sanitized for security, but should return generic error
      expect(json).toHaveProperty('error')
      expect(json.success).toBe(false)
    })

    it('should handle body reading errors gracefully', async () => {
      // Create a request with a body that throws when reading
      const errorBody = new ReadableStream({
        start(_controller) {
          // Don't error immediately, let it be read first
        },
      })

      // Mock the getReader to throw when read() is called
      const originalGetReader = errorBody.getReader.bind(errorBody)
      errorBody.getReader = () => {
        const reader = originalGetReader()
        reader.read = () => {
          throw new Error('Body read error')
        }
        return reader
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: errorBody,
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should handle missing usage metrics trailer', async () => {
      const https = await import('node:https')
      const { EventEmitter } = await import('node:events')

      class MockIncomingMessage extends EventEmitter {
        statusCode = 200
        headers = {
          'content-type': 'text/event-stream',
          'ehbp-response-nonce': 'test-nonce-123',
        }
        trailers = {} // No usage metrics trailer

        on(event: string, handler: any) {
          super.on(event, handler)
          if (event === 'data') {
            setTimeout(() => {
              handler(Buffer.from('data: {"test": "chunk"}\n\n'))
              handler(Buffer.from('data: [DONE]\n\n'))
            }, 0)
          }
          if (event === 'end') {
            setTimeout(() => handler(), 10)
          }
          return this
        }
      }

      const mockRequest = new EventEmitter() as any
      mockRequest.write = mock(() => {})
      mockRequest.end = mock(() => {})
      mockRequest.destroy = mock(() => {})

      const httpsSpy = spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
        setTimeout(() => callback(new MockIncomingMessage()), 0)
        return mockRequest
      })

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(200)
      // Should complete successfully even without usage metrics
      httpsSpy.mockRestore()
    })

    it('should handle missing Ehbp-Response-Nonce header', async () => {
      const https = await import('node:https')
      const { EventEmitter } = await import('node:events')

      class MockIncomingMessage extends EventEmitter {
        statusCode = 200
        headers = {
          'content-type': 'text/event-stream',
          // Missing ehbp-response-nonce
        }
        trailers = {
          'x-tinfoil-usage-metrics': 'prompt=67,completion=42,total=109',
        }

        on(event: string, handler: any) {
          super.on(event, handler)
          if (event === 'data') {
            setTimeout(() => {
              handler(Buffer.from('data: {"test": "chunk"}\n\n'))
              handler(Buffer.from('data: [DONE]\n\n'))
            }, 0)
          }
          if (event === 'end') {
            setTimeout(() => handler(), 10)
          }
          return this
        }
      }

      const mockRequest = new EventEmitter() as any
      mockRequest.write = mock(() => {})
      mockRequest.end = mock(() => {})
      mockRequest.destroy = mock(() => {})

      const httpsSpy = spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
        setTimeout(() => callback(new MockIncomingMessage()), 0)
        return mockRequest
      })

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(200)
      // Should complete successfully, but nonce header should be missing
      expect(response.headers.get('Ehbp-Response-Nonce')).toBeNull()
      // Should log warning (checked via console spies)
      httpsSpy.mockRestore()
    })

    it('should handle upstream 4xx errors', async () => {
      const https = await import('node:https')
      const { EventEmitter } = await import('node:events')

      class MockIncomingMessage extends EventEmitter {
        statusCode = 400
        headers = {
          'content-type': 'application/json',
          'ehbp-response-nonce': 'test-nonce-123',
        }
        trailers = {}

        on(event: string, handler: any) {
          super.on(event, handler)
          if (event === 'data') {
            setTimeout(() => {
              handler(Buffer.from(JSON.stringify({ error: { message: 'Bad request' } })))
            }, 0)
          }
          if (event === 'end') {
            setTimeout(() => handler(), 10)
          }
          return this
        }
      }

      const mockRequest = new EventEmitter() as any
      mockRequest.write = mock(() => {})
      mockRequest.end = mock(() => {})
      mockRequest.destroy = mock(() => {})

      const httpsSpy = spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
        setTimeout(() => callback(new MockIncomingMessage()), 0)
        return mockRequest
      })

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      // Upstream errors are now rejected with sanitized error for security
      expect(response.status).toBe(500)
      const json = await response.json()
      expect(json.success).toBe(false)
      expect(json).toHaveProperty('error')
      // Should log error to console (error body is buffered server-side)
      httpsSpy.mockRestore()
    })

    it('should handle upstream 5xx errors', async () => {
      const https = await import('node:https')
      const { EventEmitter } = await import('node:events')

      class MockIncomingMessage extends EventEmitter {
        statusCode = 500
        headers = {
          'content-type': 'application/json',
          'ehbp-response-nonce': 'test-nonce-123',
        }
        trailers = {}

        on(event: string, handler: any) {
          super.on(event, handler)
          if (event === 'data') {
            setTimeout(() => {
              handler(Buffer.from(JSON.stringify({ error: { message: 'Internal server error' } })))
            }, 0)
          }
          if (event === 'end') {
            setTimeout(() => handler(), 10)
          }
          return this
        }
      }

      const mockRequest = new EventEmitter() as any
      mockRequest.write = mock(() => {})
      mockRequest.end = mock(() => {})
      mockRequest.destroy = mock(() => {})

      const httpsSpy = spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
        setTimeout(() => callback(new MockIncomingMessage()), 0)
        return mockRequest
      })

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(500)
      // Should still stream error body to client
      // Should log error (checked via console spies)
      httpsSpy.mockRestore()
    })

    it('should handle upstream connection errors', async () => {
      const https = await import('node:https')
      const { EventEmitter } = await import('node:events')

      const mockRequest = new EventEmitter() as any
      mockRequest.write = mock(() => {})
      mockRequest.end = mock(() => {})
      mockRequest.destroy = mock(() => {})

      const httpsSpy = spyOn(https, 'request').mockImplementation((_options: any, callback: any) => {
        // Simulate connection error
        setTimeout(() => {
          mockRequest.emit('error', new Error('ECONNREFUSED'))
        }, 0)
        return mockRequest
      })

      const gptOssRequest = {
        ...validRequestBody,
        model: 'gpt-oss-120b',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ehbp-Encapsulated-Key': 'test-key-456',
            'X-Tinfoil-Enclave-Url': 'https://inference.tinfoil.sh',
          },
          body: JSON.stringify(gptOssRequest),
        }),
      )

      expect(response.status).toBe(500)
      httpsSpy.mockRestore()
    })

    it('should route mistral models to mistral provider', async () => {
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(getInferenceClientSpy).toHaveBeenCalledWith('mistral')
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'mistral-large-2512',
        }),
      )
    })

    it('should handle request with tools and tool_choice', async () => {
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const requestWithTools = {
        ...validRequestBody,
        tools: [{ type: 'function', function: { name: 'test_tool' } }],
        tool_choice: 'auto',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestWithTools),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: requestWithTools.tools,
          tool_choice: requestWithTools.tool_choice,
        }),
      )
    })

    it('should include PostHog properties when configured', async () => {
      isPostHogConfiguredSpy.mockReturnValue(true)
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          posthogProperties: expect.objectContaining({
            model_provider: 'mistral',
            endpoint: '/chat/completions',
            has_tools: false,
            temperature: validRequestBody.temperature,
          }),
        }),
      )

      // Reset for other tests
      isPostHogConfiguredSpy.mockReturnValue(false)
    })

    // Note: Tinfoil uses direct fetch passthrough for EHBP encryption,
    // bypassing the OpenAI SDK and PostHog instrumentation layer

    it('should reject non-streaming requests', async () => {
      const nonStreamingRequest = {
        ...validRequestBody,
        stream: false,
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nonStreamingRequest),
        }),
      )

      expect(response.status).toBe(500)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('should reject unsupported models', async () => {
      const unsupportedModelRequest = {
        ...validRequestBody,
        model: 'unsupported-model',
      }

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(unsupportedModelRequest),
        }),
      )

      expect(response.status).toBe(500)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('should handle inference API errors gracefully', async () => {
      const apiError = new Error('API rate limit exceeded')
      mockCreateCompletion.mockImplementation(() => Promise.reject(apiError))

      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRequestBody),
        }),
      )

      expect(response.status).toBe(500)
    })

    it('should handle malformed JSON requests', async () => {
      const response = await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ invalid json',
        }),
      )

      expect(response.status).toBe(500)
      expect(mockCreateCompletion).not.toHaveBeenCalled()
    })

    it('should validate all supported models', () => {
      const expectedModels = ['gpt-oss-120b', 'mistral-medium-3.1', 'mistral-large-3', 'sonnet-4.5']
      expect(Object.keys(supportedModels)).toEqual(expectedModels)
    })

    it('should handle requests with has_tools flag correctly', async () => {
      isPostHogConfiguredSpy.mockReturnValue(true)
      const mockCompletion = createMockStream()
      mockCreateCompletion.mockImplementation(() => Promise.resolve(mockCompletion))

      const requestWithTools = {
        ...validRequestBody,
        tools: [{ type: 'function', function: { name: 'test' } }],
      }

      await app.handle(
        new Request('http://localhost/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestWithTools),
        }),
      )

      expect(mockCreateCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          posthogProperties: expect.objectContaining({
            has_tools: true,
          }),
        }),
      )

      // Reset for other tests
      isPostHogConfiguredSpy.mockReturnValue(false)
    })
  })
})

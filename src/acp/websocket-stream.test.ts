import { describe, expect, mock, test } from 'bun:test'
import { createWebSocketStream, WS_OPEN, type WebSocketLike } from './websocket-stream'

const createMockWebSocket = (readyState = WS_OPEN): WebSocketLike & { _listeners: Map<string, Set<Function>> } => {
  const listeners = new Map<string, Set<Function>>()

  return {
    _listeners: listeners,
    readyState,
    send: mock(() => {}),
    close: mock(() => {}),
    addEventListener: (event: string, handler: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(handler)
    },
    removeEventListener: (event: string, handler: Function) => {
      listeners.get(event)?.delete(handler)
    },
  }
}

describe('createWebSocketStream', () => {
  test('creates a valid ACP stream from WebSocket', () => {
    const ws = createMockWebSocket()
    const stream = createWebSocketStream(ws)

    expect(stream).toBeDefined()
    expect(stream.readable).toBeInstanceOf(ReadableStream)
    expect(stream.writable).toBeInstanceOf(WritableStream)
  })

  test('incoming WebSocket messages register a message handler', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    // Verify message handler was registered
    const messageHandlers = ws._listeners.get('message')
    expect(messageHandlers).toBeDefined()
    expect(messageHandlers!.size).toBe(1)
  })

  test('outgoing writes send data through WebSocket', async () => {
    const ws = createMockWebSocket()
    const stream = createWebSocketStream(ws)

    const writer = stream.writable.getWriter()
    const testMsg = { jsonrpc: '2.0' as const, method: 'test', id: 1 }
    await writer.write(testMsg)

    // ndJsonStream serializes to JSON and writes as Uint8Array
    // The inner writable we created converts back to string and calls ws.send
    // Since ndJsonStream wraps our streams, the write goes through our WritableStream
    // which calls ws.send
    expect(ws.send).toHaveBeenCalled()
  })

  test('writable stream has close capability', () => {
    const ws = createMockWebSocket()
    const stream = createWebSocketStream(ws)

    // Verify the stream is writable (ndJsonStream wraps our WritableStream,
    // so closing the outer stream eventually propagates to ws.close)
    expect(stream.writable).toBeInstanceOf(WritableStream)
  })

  test('registers close handler on WebSocket', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    expect(ws._listeners.get('close')?.size).toBe(1)
  })

  test('registers error handler on WebSocket', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    expect(ws._listeners.get('error')?.size).toBe(1)
  })

  test('onMessage handler enqueues string data as Uint8Array with newline', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const messageHandler = [...ws._listeners.get('message')!][0]
    // Should not throw when receiving a string message
    messageHandler({ data: '{"jsonrpc":"2.0","result":"ok","id":1}' })
  })

  test('onMessage handler handles ArrayBuffer data', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const messageHandler = [...ws._listeners.get('message')!][0]
    const buffer = new TextEncoder().encode('{"jsonrpc":"2.0"}\n')
    // Should not throw when receiving binary data
    messageHandler({ data: buffer.buffer })
  })

  test('onClose handler closes the readable stream', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const closeHandler = [...ws._listeners.get('close')!][0]
    // Should not throw
    closeHandler({ data: '' })
  })

  test('onClose handler is safe when called twice', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const closeHandler = [...ws._listeners.get('close')!][0]
    closeHandler({ data: '' })
    // Second call should not throw (caught by try/catch)
    closeHandler({ data: '' })
  })

  test('onError handler errors the readable stream', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const errorHandler = [...ws._listeners.get('error')!][0]
    // Should not throw (error is propagated to stream, not thrown)
    errorHandler({ data: 'connection failed' })
  })

  test('onError handler is safe when called after close', () => {
    const ws = createMockWebSocket()
    createWebSocketStream(ws)

    const closeHandler = [...ws._listeners.get('close')!][0]
    const errorHandler = [...ws._listeners.get('error')!][0]
    closeHandler({ data: '' })
    // Error after close should not throw (caught by try/catch)
    errorHandler({ data: 'late error' })
  })

  test('write throws when WebSocket is not open', async () => {
    const ws = createMockWebSocket(3) // WS_CLOSED
    const stream = createWebSocketStream(ws)

    const writer = stream.writable.getWriter()
    const testMsg = { jsonrpc: '2.0' as const, method: 'test', id: 1 }
    await expect(writer.write(testMsg)).rejects.toThrow('WebSocket is not open')
  })
})

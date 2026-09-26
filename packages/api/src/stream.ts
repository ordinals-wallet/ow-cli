/**
 * Minimal Server-Sent Events client that runs in browsers (native
 * `EventSource`) and Node 18+ (`fetch` + `ReadableStream`), with automatic
 * reconnect and exponential backoff. No dependencies.
 */

/** One dispatched SSE event. */
export interface SseEvent {
  /** Event name; `message` when the server sent no `event:` field. */
  event: string
  /** Data lines joined with `\n`. */
  data: string
  /** Last event ID seen on the stream, if any. */
  id?: string
}

export interface SseParser {
  /** Feed a decoded text chunk. Chunks may split lines anywhere. */
  push(chunk: string): void
  /** Flush a trailing partial line (end of stream). Incomplete events are dropped, per spec. */
  end(): void
}

export interface SseParserCallbacks {
  onEvent: (event: SseEvent) => void
  /** Server-requested reconnection delay (`retry:` field), in ms. */
  onRetry?: (ms: number) => void
  /** Comment lines (e.g. `:keep-alive`), without the leading colon. */
  onComment?: (text: string) => void
}

/** Incremental parser for the `text/event-stream` format (WHATWG HTML §9.2.6). */
export function createSseParser(cb: SseParserCallbacks | ((event: SseEvent) => void)): SseParser {
  const { onEvent, onRetry, onComment } = typeof cb === 'function' ? { onEvent: cb } as SseParserCallbacks : cb
  let buf = ''
  let first = true
  let eventType = ''
  let data: string[] = []
  let lastId: string | undefined

  const dispatch = () => {
    if (data.length === 0) {
      eventType = ''
      return
    }
    const ev: SseEvent = { event: eventType || 'message', data: data.join('\n') }
    if (lastId !== undefined) ev.id = lastId
    eventType = ''
    data = []
    onEvent(ev)
  }

  const line = (l: string) => {
    if (l === '') return dispatch()
    if (l.startsWith(':')) {
      onComment?.(l.slice(1).trimStart())
      return
    }
    const i = l.indexOf(':')
    const field = i === -1 ? l : l.slice(0, i)
    let value = i === -1 ? '' : l.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        eventType = value
        break
      case 'data':
        data.push(value)
        break
      case 'id':
        if (!value.includes('\0')) lastId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) onRetry?.(Number(value))
        break
    }
  }

  const drain = (final: boolean) => {
    let start = 0
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i]
      if (c === '\n' || c === '\r') {
        // A lone trailing CR might be the first half of CRLF: wait for more.
        if (c === '\r' && i === buf.length - 1 && !final) break
        line(buf.slice(start, i))
        if (c === '\r' && buf[i + 1] === '\n') i++
        start = i + 1
      }
    }
    buf = buf.slice(start)
    if (final && buf) {
      line(buf)
      buf = ''
    }
  }

  return {
    push(chunk: string) {
      if (first && chunk.length) {
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1)
        first = false
      }
      buf += chunk
      drain(false)
    },
    end() {
      drain(true)
      // Per spec, an event without a terminating blank line is discarded.
      eventType = ''
      data = []
    },
  }
}

/** Thrown to `onError` when the stream endpoint answers with a non-2xx status. */
export class SseHttpError extends Error {
  readonly status: number
  /** Parsed `Retry-After`, in ms, when present. */
  readonly retryAfterMs?: number
  constructor(status: number, retryAfterMs?: number) {
    super(`SSE request failed with HTTP ${status}`)
    this.name = 'SseHttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value == null || value === '') return undefined
  const s = value.trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now)
}

export interface SubscribeHandlers {
  /**
   * Named-event handlers, e.g. `{ snapshot: (data) => …, delta: (data) => … }`.
   * With the EventSource transport only these names (plus `message`) are delivered.
   */
  events?: Record<string, (data: string, event: SseEvent) => void>
  /** Called for every delivered event, before its named handler. */
  onMessage?: (event: SseEvent) => void
  /** Connection (re)established. */
  onOpen?: () => void
  /** Transport errors, HTTP errors, and handler exceptions. The stream keeps reconnecting unless `fatal`. */
  onError?: (error: unknown, info: { fatal: boolean }) => void
}

export interface SubscribeOptions {
  /** `auto` uses EventSource when the runtime has it, otherwise fetch. */
  transport?: 'auto' | 'fetch' | 'eventsource'
  /** Extra request headers (fetch transport only; EventSource cannot send headers). */
  headers?: Record<string, string>
  /** First reconnect delay. Default 1000ms. */
  initialBackoffMs?: number
  /** Reconnect delay ceiling. Default 30000ms. */
  maxBackoffMs?: number
  /** Reconnect if no bytes arrive for this long (fetch transport). Default 45000ms; 0 disables. */
  idleTimeoutMs?: number
  /** Override `fetch` (tests, custom agents). */
  fetch?: typeof fetch
  /** Override the EventSource constructor. */
  EventSource?: EventSourceLike
}

/** Stop the subscription and cancel any pending reconnect. Idempotent. */
export type Unsubscribe = () => void

interface EventSourceInstance {
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  addEventListener(type: string, listener: (ev: { data: string; lastEventId?: string }) => void): void
  close(): void
}
export type EventSourceLike = new (url: string) => EventSourceInstance

/**
 * Subscribe to a Server-Sent Events endpoint. Reconnects with exponential
 * backoff (honouring `retry:` and `Retry-After`) until the returned function
 * is called. HTTP 4xx other than 408/429 is treated as fatal.
 */
export function subscribe(url: string, handlers: SubscribeHandlers, options: SubscribeOptions = {}): Unsubscribe {
  const g = globalThis as unknown as { EventSource?: EventSourceLike; fetch?: typeof fetch }
  const ES = options.EventSource ?? g.EventSource
  const transport = options.transport ?? 'auto'
  const useES = transport === 'eventsource' || (transport === 'auto' && typeof ES === 'function')
  if (useES && typeof ES !== 'function') throw new Error('EventSource is not available in this runtime')
  if (!useES && typeof (options.fetch ?? g.fetch) !== 'function') {
    throw new Error('fetch is not available in this runtime (Node 18+ required)')
  }

  const initial = options.initialBackoffMs ?? 1000
  const max = options.maxBackoffMs ?? 30000
  let serverRetry: number | undefined
  let attempt = 0
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopCurrent: (() => void) | undefined
  let lastEventId: string | undefined

  const report = (err: unknown, fatal = false) => {
    try {
      handlers.onError?.(err, { fatal })
    } catch {
      /* never let a handler break the loop */
    }
  }

  const deliver = (ev: SseEvent) => {
    attempt = 0
    try {
      handlers.onMessage?.(ev)
      handlers.events?.[ev.event]?.(ev.data, ev)
    } catch (err) {
      report(err)
    }
  }

  const backoff = (): number => {
    const base = serverRetry ?? initial
    const d = Math.min(max, base * 2 ** attempt)
    attempt++
    return Math.round(d * (0.8 + Math.random() * 0.4))
  }

  const schedule = (delay: number) => {
    if (closed) return
    timer = setTimeout(() => {
      timer = undefined
      if (!closed) connect()
    }, delay)
  }

  const connect = useES ? connectEventSource : connectFetch

  function connectEventSource() {
    const es = new ES!(url)
    stopCurrent = () => es.close()
    es.onopen = () => {
      attempt = 0
      handlers.onOpen?.()
    }
    es.onerror = (e) => {
      report(e)
      // CONNECTING (0) = the browser is already retrying; CLOSED (2) = it gave up.
      if (es.readyState === 2 && !closed) {
        es.close()
        schedule(backoff())
      }
    }
    const names = new Set(['message', ...Object.keys(handlers.events ?? {})])
    for (const name of names) {
      es.addEventListener(name, (m) => deliver({ event: name, data: m.data, id: m.lastEventId || undefined }))
    }
  }

  function connectFetch() {
    const fetchImpl = options.fetch ?? g.fetch!
    const ac = new AbortController()
    let idle: ReturnType<typeof setTimeout> | undefined
    const idleMs = options.idleTimeoutMs ?? 45000
    const clearIdle = () => idle !== undefined && clearTimeout(idle)
    const armIdle = () => {
      clearIdle()
      if (idleMs > 0) idle = setTimeout(() => ac.abort(new Error('SSE idle timeout')), idleMs)
    }
    let lastId: string | undefined
    stopCurrent = () => {
      clearIdle()
      ac.abort()
    }

    const run = async () => {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...options.headers,
      }
      if (lastEventId) headers['Last-Event-ID'] = lastEventId
      armIdle()
      const res = await fetchImpl(url, { headers, signal: ac.signal })
      if (!res.ok) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        throw new SseHttpError(res.status, retryAfter)
      }
      if (!res.body) throw new Error('SSE response has no body')
      handlers.onOpen?.()
      const parser = createSseParser({
        onEvent: (ev) => {
          if (ev.id !== undefined) lastId = ev.id
          deliver(ev)
        },
        onRetry: (ms) => {
          serverRetry = ms
        },
      })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle()
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.end()
      throw new Error('SSE stream ended')
    }

    run()
      .catch((err: unknown) => {
        clearIdle()
        if (lastId !== undefined) lastEventId = lastId
        if (closed) return
        if (err instanceof SseHttpError) {
          const fatal = err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429
          report(err, fatal)
          if (fatal) {
            closed = true
            return
          }
          schedule(err.retryAfterMs ?? backoff())
          return
        }
        report(err)
        schedule(backoff())
      })
  }
  connect()

  return () => {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    stopCurrent?.()
    stopCurrent = undefined
  }
}

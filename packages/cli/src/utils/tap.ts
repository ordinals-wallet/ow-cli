/**
 * TAP token balances from tap.trac.network.
 *
 * The service speaks Socket.IO v4. Rather than pull in socket.io-client (and
 * its engine.io/ws/debug tree), this talks the small subset of the wire
 * protocol we need over the runtime's built-in `WebSocket` (Node 22+):
 *
 *   server  0{"sid":…}          engine.io OPEN
 *   client  40                  socket.io CONNECT (default namespace)
 *   server  40{"sid":…}         CONNECT ack
 *   client  42["get",{…}]       EVENT
 *   server  42["response",{…}]  EVENT
 *   server  2 / client 3        ping / pong
 *   server  44{…}               CONNECT_ERROR
 */

const TAP_WS_URL = 'wss://tap.trac.network/socket.io/?EIO=4&transport=websocket'

export interface TapToken {
  ticker: string
  overall_balance: number
  available_balance: number
  transferable_balance: number
}

interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number }) => void) | null
  send(data: string): void
  close(): void
}
export type WebSocketCtor = new (url: string) => WebSocketLike

interface TapResponse {
  func: string
  args: string[]
  result: unknown
}

export interface TapBalanceOptions {
  timeoutMs?: number
  /** Override the WebSocket constructor (tests). Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketCtor
  url?: string
}

/**
 * Balances for every TAP token the address holds. Resolves with whatever
 * arrived if the timeout hits after the connection was established; rejects
 * when the connection cannot be made.
 */
export function getTapBalance(address: string, options: TapBalanceOptions = {}): Promise<TapToken[]> {
  const timeoutMs = options.timeoutMs ?? 15000
  const WS = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (typeof WS !== 'function') {
    return Promise.reject(new Error('TAP balances need a runtime with WebSocket (Node 22+)'))
  }

  return new Promise((resolve, reject) => {
    const tokens = new Map<string, TapToken>()
    let connected = false
    let settled = false
    let tickersReceived = false
    let pendingBalances = 0
    let pendingTransfers = 0

    const ws = new WS(options.url ?? TAP_WS_URL)

    const result = () => Array.from(tokens.values()).filter((t) => t.overall_balance > 0)
    const finish = (err?: Error, value?: TapToken[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.onmessage = ws.onerror = ws.onclose = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(value ?? result())
    }

    const timer = setTimeout(() => {
      if (connected) finish(undefined, result())
      else finish(new Error('TAP connection failed: timeout'))
    }, timeoutMs)

    const emit = (func: string, args: unknown[]) => {
      ws.send('42' + JSON.stringify(['get', { func, args, call_id: '' }]))
    }

    const checkDone = () => {
      if (tickersReceived && pendingBalances === 0 && pendingTransfers === 0) finish()
    }

    const onResponse = (value: TapResponse) => {
      if (value.func === 'accountTokens') {
        const tickers = (value.result as string[] | null) || []
        tickersReceived = true
        if (tickers.length === 0) return finish(undefined, [])
        pendingBalances = tickers.length
        for (const ticker of tickers) emit('balance', [address, ticker])
        return
      }
      if (value.func === 'balance') {
        pendingBalances--
        const ticker = value.args[1]
        const isDmt = ticker.startsWith('dmt')
        const balance = parseInt(value.result as string, 10) / (isDmt ? 1 : 1e18)
        tokens.set(ticker.toUpperCase(), {
          ticker: ticker.toUpperCase(),
          overall_balance: balance,
          available_balance: balance,
          transferable_balance: 0,
        })
        pendingTransfers++
        emit('transferable', [address, ticker])
        return checkDone()
      }
      if (value.func === 'transferable') {
        pendingTransfers--
        const ticker = value.args[1].toUpperCase()
        const isDmt = value.args[1].startsWith('dmt')
        const transferable = parseInt((value.result as string) || '0', 10) / (isDmt ? 1 : 1e18)
        const existing = tokens.get(ticker)
        if (existing) {
          existing.transferable_balance = transferable
          existing.available_balance = existing.overall_balance - transferable
        }
        return checkDone()
      }
    }

    ws.onmessage = (ev) => {
      const frame = typeof ev.data === 'string' ? ev.data : String(ev.data)
      const type = frame[0]
      if (type === '0') {
        ws.send('40') // engine.io open → join the default namespace
      } else if (type === '2') {
        ws.send('3') // ping → pong
      } else if (type === '1') {
        if (!settled) finish(connected ? undefined : new Error('TAP connection failed: closed by server'))
      } else if (type === '4') {
        const sub = frame[1]
        const payload = frame.slice(2)
        if (sub === '0') {
          connected = true
          emit('accountTokens', [address, 0, 500])
        } else if (sub === '4') {
          let msg = 'connect error'
          try {
            msg = (JSON.parse(payload) as { message?: string }).message ?? msg
          } catch {
            /* keep default */
          }
          finish(new Error(`TAP connection failed: ${msg}`))
        } else if (sub === '2') {
          try {
            const [name, value] = JSON.parse(payload) as [string, TapResponse]
            if (name === 'response' && value && typeof value.func === 'string') onResponse(value)
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    }
    ws.onerror = () => {
      if (!connected) finish(new Error('TAP connection failed: websocket error'))
    }
    ws.onclose = () => {
      if (connected) finish()
      else finish(new Error('TAP connection failed: connection closed'))
    }
  })
}

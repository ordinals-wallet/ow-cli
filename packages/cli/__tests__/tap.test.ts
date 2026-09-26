import { describe, it, expect } from 'vitest'
import { getTapBalance, type WebSocketCtor } from '../src/utils/tap.js'

type Handler = (frame: string, ws: FakeSocket) => void

class FakeSocket {
  static script: Handler
  static last: FakeSocket
  sent: string[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  constructor(public url: string) {
    FakeSocket.last = this
    queueMicrotask(() => this.recv('0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'))
  }
  recv(frame: string) {
    this.onmessage?.({ data: frame })
  }
  send(frame: string) {
    this.sent.push(frame)
    queueMicrotask(() => FakeSocket.script(frame, this))
  }
  close() {
    this.closed = true
  }
}

const WS = FakeSocket as unknown as WebSocketCtor
const ADDR = 'bc1ptest'
const resp = (func: string, args: unknown[], result: unknown) => '42' + JSON.stringify(['response', { func, args, result }])

function server(balances: Record<string, [string, string]>): Handler {
  return (frame, ws) => {
    if (frame === '40') return ws.recv('40{"sid":"n1"}')
    if (!frame.startsWith('42')) return
    const [, req] = JSON.parse(frame.slice(2)) as [string, { func: string; args: string[] }]
    if (req.func === 'accountTokens') ws.recv(resp('accountTokens', req.args, Object.keys(balances)))
    if (req.func === 'balance') ws.recv(resp('balance', req.args, balances[req.args[1]][0]))
    if (req.func === 'transferable') ws.recv(resp('transferable', req.args, balances[req.args[1]][1]))
  }
}

describe('TAP balance over native WebSocket (Socket.IO v4 frames)', () => {
  it('joins the namespace, queries tokens, balances and transferables', async () => {
    FakeSocket.script = server({ 'dmt-nat': ['500', '100'], tap: ['2000000000000000000', '0'] })
    const tokens = await getTapBalance(ADDR, { WebSocket: WS, timeoutMs: 1000 })
    expect(FakeSocket.last.url).toContain('/socket.io/?EIO=4&transport=websocket')
    expect(FakeSocket.last.sent[0]).toBe('40')
    expect(JSON.parse(FakeSocket.last.sent[1].slice(2))).toEqual(['get', { func: 'accountTokens', args: [ADDR, 0, 500], call_id: '' }])
    expect(tokens).toEqual([
      { ticker: 'DMT-NAT', overall_balance: 500, available_balance: 400, transferable_balance: 100 },
      { ticker: 'TAP', overall_balance: 2, available_balance: 2, transferable_balance: 0 },
    ])
    expect(FakeSocket.last.closed).toBe(true)
  })

  it('answers engine.io pings and resolves [] for an empty account', async () => {
    FakeSocket.script = (frame, ws) => {
      if (frame === '40') {
        ws.recv('2')
        return ws.recv('40{"sid":"n1"}')
      }
      if (frame.startsWith('42')) ws.recv(resp('accountTokens', [ADDR, '0', '500'], []))
    }
    expect(await getTapBalance(ADDR, { WebSocket: WS, timeoutMs: 1000 })).toEqual([])
    expect(FakeSocket.last.sent).toContain('3')
  })

  it('rejects on CONNECT_ERROR and on a connection that never opens', async () => {
    FakeSocket.script = (frame, ws) => {
      if (frame === '40') ws.recv('44{"message":"Not authorized"}')
    }
    await expect(getTapBalance(ADDR, { WebSocket: WS, timeoutMs: 1000 })).rejects.toThrow('TAP connection failed: Not authorized')

    FakeSocket.script = () => {}
    class Silent extends FakeSocket {
      constructor(url: string) {
        super(url)
        queueMicrotask(() => this.onclose?.({ code: 1006 }))
      }
    }
    await expect(getTapBalance(ADDR, { WebSocket: Silent as unknown as WebSocketCtor, timeoutMs: 1000 })).rejects.toThrow(/TAP connection failed/)
  })

  it('returns partial results when the timeout hits after connecting', async () => {
    FakeSocket.script = (frame, ws) => {
      if (frame === '40') return ws.recv('40{"sid":"n1"}')
      const [, req] = JSON.parse(frame.slice(2)) as [string, { func: string; args: string[] }]
      if (req.func === 'accountTokens') ws.recv(resp('accountTokens', req.args, ['tap']))
      if (req.func === 'balance') ws.recv(resp('balance', req.args, '1000000000000000000'))
      // never answers `transferable`
    }
    expect(await getTapBalance(ADDR, { WebSocket: WS, timeoutMs: 50 })).toEqual([
      { ticker: 'TAP', overall_balance: 1, available_balance: 1, transferable_balance: 0 },
    ])
  })

  it('explains when the runtime has no WebSocket', async () => {
    const g = globalThis as { WebSocket?: unknown }
    const saved = g.WebSocket
    g.WebSocket = undefined
    try {
      await expect(getTapBalance(ADDR)).rejects.toThrow(/Node 22\+/)
    } finally {
      g.WebSocket = saved
    }
  })
})

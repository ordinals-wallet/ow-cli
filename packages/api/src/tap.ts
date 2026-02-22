import { io, type Socket } from 'socket.io-client'

const TAP_URL = 'https://tap.trac.network/'

export interface TapToken {
  ticker: string
  overall_balance: number
  available_balance: number
  transferable_balance: number
}

export async function getTapBalance(address: string, timeoutMs = 15000): Promise<TapToken[]> {
  return new Promise((resolve, reject) => {
    const socket: Socket = io(TAP_URL, {
      autoConnect: true,
      reconnection: false,
      timeout: timeoutMs,
    })

    const tokens = new Map<string, TapToken>()
    let pendingBalances = 0
    let pendingTransfers = 0
    let tickersReceived = false
    let timer: ReturnType<typeof setTimeout>

    function checkDone() {
      if (tickersReceived && pendingBalances === 0 && pendingTransfers === 0) {
        clearTimeout(timer)
        socket.disconnect()
        resolve(Array.from(tokens.values()).filter(t => t.overall_balance > 0))
      }
    }

    timer = setTimeout(() => {
      socket.disconnect()
      // Return what we have so far
      resolve(Array.from(tokens.values()).filter(t => t.overall_balance > 0))
    }, timeoutMs)

    socket.on('connect_error', (err) => {
      clearTimeout(timer)
      socket.disconnect()
      reject(new Error(`TAP connection failed: ${err.message}`))
    })

    socket.on('response', (value: { func: string; args: string[]; result: unknown }) => {
      if (value.func === 'accountTokens') {
        const tickers = (value.result as string[] | null) || []
        tickersReceived = true

        if (tickers.length === 0) {
          clearTimeout(timer)
          socket.disconnect()
          resolve([])
          return
        }

        pendingBalances = tickers.length
        for (const ticker of tickers) {
          socket.emit('get', {
            func: 'balance',
            args: [address, ticker],
            call_id: '',
          })
        }
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
        socket.emit('get', {
          func: 'transferable',
          args: [address, ticker],
          call_id: '',
        })

        checkDone()
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

        checkDone()
      }
    })

    socket.emit('get', {
      func: 'accountTokens',
      args: [address, 0, 500],
      call_id: '',
    })
  })
}

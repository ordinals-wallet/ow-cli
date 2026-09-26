/**
 * Interactive prompts on node:readline — no third-party prompt library, so
 * nothing outside Node itself ever sees a typed password or seed phrase.
 *
 * On a TTY: masked password entry, y/N confirm, text input and an arrow-key
 * list. When stdin is piped, every prompt reads one line (no masking needed,
 * nothing is echoed), so scripted use keeps working.
 */
import { createInterface, type Interface } from 'node:readline'

const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const CTRL_U = '\u0015'
const BACKSPACE = new Set(['\u007f', '\b'])
const ESC = '\u001b'

const isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)
const cyan = (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[36m${s}\u001b[39m` : s)

function interrupted(): never {
  process.stdout.write('\n')
  process.exit(130)
}

// ─── Line input ─────────────────────────────────────────────────────

// Piped stdin: one shared reader, so lines buffered by an earlier prompt are
// not lost when the next prompt starts.
let piped: { rl: Interface; lines: string[]; waiters: ((line: string | null) => void)[]; ended: boolean } | null = null

function pipedLine(): Promise<string | null> {
  if (!piped) {
    const rl = createInterface({ input: process.stdin, terminal: false })
    const state = { rl, lines: [] as string[], waiters: [] as ((line: string | null) => void)[], ended: false }
    rl.on('line', (line) => {
      const w = state.waiters.shift()
      if (w) w(line)
      else state.lines.push(line)
    })
    rl.on('close', () => {
      state.ended = true
      for (const w of state.waiters.splice(0)) w(null)
    })
    piped = state
  }
  const s = piped
  if (s.lines.length) return Promise.resolve(s.lines.shift()!)
  if (s.ended) return Promise.resolve(null)
  return new Promise((resolve) => s.waiters.push(resolve))
}

async function readLine(message: string): Promise<string> {
  if (!isTTY()) {
    process.stdout.write(message)
    const line = await pipedLine()
    if (line === null) throw new Error('No input (stdin closed)')
    process.stdout.write('\n')
    return line
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  return new Promise((resolve) => {
    rl.on('SIGINT', () => {
      rl.close()
      interrupted()
    })
    rl.question(message, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Reads a line without echoing it; each character shows as `mask`. */
function readHidden(message: string, mask = '*'): Promise<string> {
  if (!isTTY()) return readLine(message)
  const { stdin, stdout } = process
  stdout.write(message)
  return new Promise((resolve) => {
    let value: string[] = []
    let inEscape = false
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()

    const finish = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdout.write('\n')
    }
    const erase = (n: number) => {
      if (n > 0 && mask) stdout.write('\b \b'.repeat(n))
    }

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (inEscape) {
          // Skip the rest of an escape sequence (arrow keys etc.).
          if (/[A-Za-z~]/.test(ch)) inEscape = false
          continue
        }
        if (ch === ESC) {
          inEscape = true
        } else if (ch === '\r' || ch === '\n') {
          finish()
          resolve(value.join(''))
          return
        } else if (ch === CTRL_C) {
          finish()
          interrupted()
        } else if (ch === CTRL_D) {
          if (value.length === 0) {
            finish()
            interrupted()
          }
        } else if (BACKSPACE.has(ch)) {
          if (value.length) {
            value = value.slice(0, -1)
            erase(1)
          }
        } else if (ch === CTRL_U) {
          erase(value.length)
          value = []
        } else if (ch >= ' ') {
          value.push(ch)
          if (mask) stdout.write(mask)
        }
      }
    }
    stdin.on('data', onData)
  })
}

// ─── Public prompts ─────────────────────────────────────────────────

export async function promptPassword(message = 'Enter password: '): Promise<string> {
  return readHidden(withSpace(message))
}

/** A secret such as a mnemonic or WIF: masked like a password. */
export async function promptSecret(message: string): Promise<string> {
  return readHidden(withSpace(message))
}

export async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  const hint = defaultValue ? '(Y/n)' : '(y/N)'
  for (;;) {
    const answer = (await readLine(`${withSpace(message)}${hint} `)).trim().toLowerCase()
    if (answer === '') return defaultValue
    if (answer === 'y' || answer === 'yes') return true
    if (answer === 'n' || answer === 'no') return false
    if (!isTTY()) return false
  }
}

export async function requireConfirm(message: string): Promise<void> {
  const confirmed = await promptConfirm(message)
  if (!confirmed) {
    console.log('Cancelled.')
    throw { cancelled: true }
  }
}

export async function promptInput(message: string): Promise<string> {
  return readLine(withSpace(message))
}

export interface SelectChoice<T> {
  name: string
  value: T
}

/**
 * Pick one choice. On a TTY: arrow keys (or j/k, or the item number) and
 * Enter. Piped: prints a numbered list and reads a number.
 */
export async function promptSelect<T>(message: string, choices: SelectChoice<T>[], initial = 0): Promise<T> {
  if (choices.length === 0) throw new Error('Nothing to select')
  if (!isTTY()) {
    choices.forEach((c, i) => process.stdout.write(`  ${i + 1}) ${c.name}\n`))
    const n = parseInt(await readLine(`${withSpace(message)}(1-${choices.length}) `), 10)
    if (!Number.isInteger(n) || n < 1 || n > choices.length) throw new Error('Invalid selection')
    return choices[n - 1].value
  }

  const { stdin, stdout } = process
  let idx = Math.min(Math.max(0, initial), choices.length - 1)
  const header = `? ${message}`
  const draw = (redraw: boolean) => {
    if (redraw) stdout.write(`\u001b[${choices.length}A`)
    choices.forEach((c, i) => {
      const line = i === idx ? cyan(`❯ ${c.name}`) : `  ${c.name}`
      stdout.write(`\u001b[2K\r${line}\n`)
    })
  }

  stdout.write(`${header} (Use arrow keys)\n`)
  stdout.write('\u001b[?25l') // hide cursor
  draw(false)

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()

    const finish = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      // Replace the list with the chosen answer.
      stdout.write(`\u001b[${choices.length + 1}A`)
      for (let i = 0; i <= choices.length; i++) stdout.write('\u001b[2K\n')
      stdout.write(`\u001b[${choices.length + 1}A`)
      stdout.write('\u001b[?25h')
    }

    const onData = (key: string) => {
      if (key === CTRL_C || key === CTRL_D) {
        finish()
        interrupted()
      }
      if (key === '\r' || key === '\n') {
        finish()
        stdout.write(`${header} ${cyan(choices[idx].name)}\n`)
        resolve(choices[idx].value)
        return
      }
      if (key === '\u001b[A' || key === 'k') idx = (idx - 1 + choices.length) % choices.length
      else if (key === '\u001b[B' || key === 'j') idx = (idx + 1) % choices.length
      else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) idx = Number(key) - 1
      else return
      draw(true)
    }
    stdin.on('data', onData)
  })
}

function withSpace(message: string): string {
  return /\s$/.test(message) ? message : `${message} `
}

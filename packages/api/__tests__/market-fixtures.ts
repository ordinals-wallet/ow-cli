import { readFileSync } from 'node:fs'

// Real responses captured from https://turbo.ordinalswallet.com (trimmed).
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/api/${name}`, import.meta.url), 'utf8')) as T
}

export function sseFixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/sse/${name}`, import.meta.url), 'utf8')
}

/** A ReadableStream that emits `text` in the given chunk sizes (cycled). */
export function textStream(text: string, sizes: number[] = [text.length]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let i = 0
  let n = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close()
      const size = Math.max(1, sizes[n++ % sizes.length])
      controller.enqueue(bytes.slice(i, i + size))
      i += size
    },
  })
}

import { useState, useCallback } from 'react'

export interface Page {
  id: string
  title: string
  data?: unknown
}

export function useNavigation(initialPage: Page) {
  const [stack, setStack] = useState<Page[]>([initialPage])
  const [cursor, setCursor] = useState(0)

  const current = stack[stack.length - 1]

  const push = useCallback((page: Page) => {
    setStack((prev) => [...prev, page])
    setCursor(0)
  }, [])

  const pop = useCallback(() => {
    if (stack.length > 1) {
      setStack((prev) => prev.slice(0, -1))
      setCursor(0)
      return true
    }
    return false
  }, [stack.length])

  const moveCursor = useCallback((delta: number, maxIndex: number) => {
    setCursor((prev) => {
      const next = prev + delta
      if (next < 0) return 0
      if (next > maxIndex) return maxIndex
      return next
    })
  }, [])

  const resetCursor = useCallback(() => setCursor(0), [])

  return { current, stack, cursor, push, pop, moveCursor, resetCursor }
}

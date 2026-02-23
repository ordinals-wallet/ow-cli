import { useState, useEffect } from 'react'

export function useTerminalSize() {
  const [size, setSize] = useState({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  })

  useEffect(() => {
    function onResize() {
      setSize({
        columns: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      })
    }

    process.stdout.on('resize', onResize)
    return () => { process.stdout.off('resize', onResize) }
  }, [])

  return size
}

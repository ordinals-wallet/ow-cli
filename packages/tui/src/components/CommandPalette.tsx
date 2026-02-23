import React from 'react'
import { Box, Text } from 'ink'

export interface CommandTarget {
  id: string
  label: string
  description: string
}

interface CommandPaletteProps {
  query: string
  targets: CommandTarget[]
  cursor: number
}

export function CommandPalette({ query, targets, cursor }: CommandPaletteProps) {
  const filtered = targets.filter((t) =>
    t.label.toLowerCase().includes(query.toLowerCase()) ||
    t.description.toLowerCase().includes(query.toLowerCase())
  )

  if (filtered.length === 0) {
    return (
      <Box paddingX={2}>
        <Text dimColor>No matches</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2}>
      {filtered.map((t, i) => {
        const isCursor = i === cursor
        return (
          <Box key={t.id}>
            <Text color={isCursor ? 'magenta' : undefined} bold={isCursor}>
              {isCursor ? '> ' : '  '}
              {t.label}
            </Text>
            <Text dimColor>  {t.description}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function filterTargets(targets: CommandTarget[], query: string): CommandTarget[] {
  if (!query) return targets
  return targets.filter((t) =>
    t.label.toLowerCase().includes(query.toLowerCase()) ||
    t.description.toLowerCase().includes(query.toLowerCase())
  )
}

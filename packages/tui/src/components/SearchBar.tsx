import React from 'react'
import { Box, Text } from 'ink'

const borderColor = '#673BFE'
const cursorColor = '#956EFE'

interface SearchBarProps {
  mode: 'search' | 'command' | null
  query: string
}

export function SearchBar({ mode, query }: SearchBarProps) {
  if (!mode) return null

  const prefix = mode === 'search' ? '/' : ':'
  const termWidth = process.stdout.columns || 80
  const borderWidth = termWidth - 4
  const label = mode === 'search' ? ' Filter ' : ' Command '
  const innerText = `${prefix}${query}|`
  const padded = innerText.padEnd(borderWidth)
  const topAfterLabel = Math.max(0, borderWidth - 1 - label.length)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={borderColor}>┌─</Text>
        <Text color={cursorColor} bold>{label}</Text>
        <Text color={borderColor}>{'─'.repeat(topAfterLabel)}┐</Text>
      </Text>
      <Text>
        <Text color={borderColor}>│</Text>
        <Text> {prefix}</Text>
        <Text>{query}</Text>
        <Text dimColor>│</Text>
        <Text>{' '.repeat(Math.max(0, borderWidth - innerText.length - 1))}</Text>
        <Text color={borderColor}>│</Text>
      </Text>
      <Text>
        <Text color={borderColor}>└{'─'.repeat(borderWidth)}┘</Text>
      </Text>
    </Box>
  )
}

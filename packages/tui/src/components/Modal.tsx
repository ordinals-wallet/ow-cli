import React from 'react'
import { Box, Text } from 'ink'

const borderColor = '#673BFE'
const cursorColor = '#956EFE'

interface ModalProps {
  title: string
  prompt: string
  value: string
  masked?: boolean
  error?: string
  termWidth: number
  termHeight: number
}

export function Modal({ title, prompt, value, masked, error, termWidth, termHeight }: ModalProps) {
  const modalWidth = Math.min(42, termWidth - 4)
  const innerWidth = modalWidth - 4

  const displayValue = masked ? '*'.repeat(value.length) : value
  const inputLine = `> ${displayValue}|`
  const paddedInput = inputLine.length < innerWidth
    ? inputLine + ' '.repeat(innerWidth - inputLine.length)
    : inputLine.slice(0, innerWidth)

  const label = ` ${title} `
  const topAfterLabel = Math.max(0, modalWidth - 3 - label.length)
  const emptyLine = ' '.repeat(innerWidth)

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Text>
        <Text color={borderColor}>{'┌─'}</Text>
        <Text color={cursorColor} bold>{label}</Text>
        <Text color={borderColor}>{'─'.repeat(topAfterLabel)}{'┐'}</Text>
      </Text>

      {/* Empty line */}
      <Text>
        <Text color={borderColor}>{'│'}</Text>
        <Text>  {emptyLine}</Text>
        <Text color={borderColor}>{'│'}</Text>
      </Text>

      {/* Prompt line */}
      <Text>
        <Text color={borderColor}>{'│'}</Text>
        <Text>  {prompt.padEnd(innerWidth)}</Text>
        <Text color={borderColor}>{'│'}</Text>
      </Text>

      {/* Input line */}
      <Text>
        <Text color={borderColor}>{'│'}</Text>
        <Text>  {paddedInput}</Text>
        <Text color={borderColor}>{'│'}</Text>
      </Text>

      {/* Empty line */}
      <Text>
        <Text color={borderColor}>{'│'}</Text>
        <Text>  {emptyLine}</Text>
        <Text color={borderColor}>{'│'}</Text>
      </Text>

      {/* Error line (if any) */}
      {error ? (
        <Text>
          <Text color={borderColor}>{'│'}</Text>
          <Text color="red">  {error.padEnd(innerWidth)}</Text>
          <Text color={borderColor}>{'│'}</Text>
        </Text>
      ) : null}

      {error ? (
        <Text>
          <Text color={borderColor}>{'│'}</Text>
          <Text>  {emptyLine}</Text>
          <Text color={borderColor}>{'│'}</Text>
        </Text>
      ) : null}

      {/* Bottom border */}
      <Text>
        <Text color={borderColor}>{'└'}{'─'.repeat(modalWidth - 2)}{'┘'}</Text>
      </Text>
    </Box>
  )
}

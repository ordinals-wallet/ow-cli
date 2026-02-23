import React, { useMemo } from 'react'
import { Box, Text } from 'ink'

const cursorColor = '#956EFE'
const borderColor = '#673BFE'

export interface Column {
  header: string
  width?: number
  align?: 'left' | 'right'
}

interface TableProps {
  columns: Column[]
  rows: string[][]
  cursor: number
  title?: string
  height?: number
}

export function Table({ columns, rows, cursor, title, height }: TableProps) {
  const termWidth = process.stdout.columns || 80
  const tableHeight = height ?? (process.stdout.rows || 24)
  const contentWidth = termWidth - 4 // 2 padding + 2 border chars

  // Even column distribution
  const gapSpace = (columns.length - 1) * 2 + 2
  const availForCols = contentWidth - gapSpace
  const baseColWidth = Math.floor(availForCols / columns.length)
  const colLeftover = availForCols - baseColWidth * columns.length
  const widths = columns.map((_, i) => baseColWidth + (i < colLeftover ? 1 : 0))

  const bw = contentWidth

  const pad = (text: string, width: number, align: 'left' | 'right' = 'left') => {
    const truncated = text.length > width ? text.slice(0, width - 1) + '…' : text
    return align === 'right' ? truncated.padStart(width) : truncated.padEnd(width)
  }

  const makeLine = (row: string[]) =>
    ' ' + row.map((cell, i) => pad(cell, widths[i], columns[i]?.align)).join('  ') + ' '

  // Pre-build all lines as plain strings, then render as minimal Text nodes
  const output = useMemo(() => {
    const lines: string[] = []

    // Top border with title
    const titleStr = title
      ? (rows.length > 0 ? ` ${title}[${rows.length}] ` : ` ${title} `)
      : ''
    if (title) {
      lines.push('┌─' + titleStr + '─'.repeat(Math.max(0, bw - 1 - titleStr.length)) + '┐')
    } else {
      lines.push('┌' + '─'.repeat(bw) + '┐')
    }

    // Header
    lines.push('│' + makeLine(columns.map((c) => c.header.toUpperCase())) + '│')

    // Data rows
    if (rows.length === 0) {
      lines.push('│' + ' No items'.padEnd(bw) + '│')
    } else {
      for (const row of rows) {
        lines.push('│' + makeLine(row) + '│')
      }
    }

    // Filler
    const dataLines = rows.length === 0 ? 1 : rows.length
    const usedLines = 1 + 1 + dataLines + 1
    const fillerCount = Math.max(0, tableHeight - usedLines)
    const emptyRow = '│' + ' '.repeat(bw) + '│'
    for (let i = 0; i < fillerCount; i++) {
      lines.push(emptyRow)
    }

    // Bottom border
    lines.push('└' + '─'.repeat(bw) + '┘')

    return lines
  }, [columns, rows, title, bw, tableHeight])

  // Render: one Text per line, only cursor row gets special styling
  // Header row index = 1, data starts at index 2
  const dataStart = 2
  const dataEnd = dataStart + (rows.length === 0 ? 1 : rows.length)

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      {output.map((line, i) => {
        // Is this a data row with the cursor?
        const isDataRow = i >= dataStart && i < dataEnd
        const rowIdx = i - dataStart
        const isCursor = isDataRow && rows.length > 0 && rowIdx === cursor

        if (isCursor) {
          // Split: border │ + content + border │
          const inner = line.slice(1, -1)
          return (
            <Text key={i}>
              <Text color={borderColor}>│</Text>
              <Text backgroundColor={cursorColor} color="#000000" bold>{inner}</Text>
              <Text color={borderColor}>│</Text>
            </Text>
          )
        }

        // Title line gets colored title
        if (i === 0 && title) {
          const titleStr = title
            ? (rows.length > 0 ? ` ${title}[${rows.length}] ` : ` ${title} `)
            : ''
          const after = Math.max(0, bw - 1 - titleStr.length)
          return (
            <Text key={i}>
              <Text color={borderColor}>┌─</Text>
              <Text color={cursorColor} bold>{titleStr}</Text>
              <Text color={borderColor}>{'─'.repeat(after)}┐</Text>
            </Text>
          )
        }

        // Header row: white bold text
        if (i === 1) {
          const inner = line.slice(1, -1)
          return (
            <Text key={i}>
              <Text color={borderColor}>│</Text>
              <Text color="white" bold>{inner}</Text>
              <Text color={borderColor}>│</Text>
            </Text>
          )
        }

        // Everything else: border color for │ chars, dim for filler
        return <Text key={i} color={borderColor}>{line}</Text>
      })}
    </Box>
  )
}

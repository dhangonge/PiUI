/* eslint-disable react-refresh/only-export-components -- 表格渲染组件与 renderTableFromSrc 投影同文件，拆开会让 marked lexer 逻辑悬空 */
import { memo } from 'react'
import { marked } from 'marked'
import type { Tokens } from 'marked'
import { CopyButton } from './ui'
import { renderInlineTokensToReact } from './markdownInline'

// ─── Markdown Table (React) ─────────────────────────────────────

const MarkdownTable = memo(function MarkdownTable({
  children,
  isReasoning,
}: {
  children: React.ReactNode
  isReasoning: boolean
}) {
  if (isReasoning) {
    return (
      <div className="overflow-x-auto my-2 first:mt-0 last:mb-0 w-full">
        <table className="min-w-full border-collapse text-[length:var(--fs-sm)]">{children}</table>
      </div>
    )
  }

  return (
    <div className="group/table relative my-5 first:mt-0 last:mb-0 rounded-md border border-border-200/35 w-full">
      <div className="overflow-x-auto">
        <table className="w-full text-[length:var(--fs-md)] border-collapse">{children}</table>
      </div>
    </div>
  )
})

function MarkdownTableCell({
  children,
  isHeader,
  isReasoning,
}: {
  children: React.ReactNode
  isHeader: boolean
  isReasoning: boolean
}) {
  if (isHeader) {
    return (
      <th
        className={
          isReasoning
            ? 'px-3 py-1.5 text-left text-[length:var(--fs-sm)] font-medium whitespace-nowrap border-b border-border-200/32'
            : 'relative px-3 py-2.5 text-left text-[length:var(--fs-md)] font-semibold whitespace-nowrap border-b border-border-200/38'
        }
      >
        {children}
      </th>
    )
  }
  return (
    <td
      className={
        isReasoning
          ? 'px-3 py-1.5 text-[length:var(--fs-sm)] text-text-300 w-max border-b border-border-200/18'
          : 'px-3 py-2 text-[length:var(--fs-md)] text-text-300 leading-[1.55] w-max border-b border-border-200/14'
      }
    >
      {children}
    </td>
  )
}

function MarkdownTableRow({ children, isReasoning }: { children: React.ReactNode; isReasoning: boolean }) {
  return (
    <tr className={isReasoning ? 'hover:bg-bg-200/10 transition-colors' : 'hover:bg-bg-200/12 transition-colors'}>
      {children}
    </tr>
  )
}

function MarkdownTableHeader({ children, isReasoning }: { children: React.ReactNode; isReasoning: boolean }) {
  return <thead className={isReasoning ? 'text-text-400' : 'text-text-200'}>{children}</thead>
}

export function renderTableFromSrc(src: string, isReasoning: boolean): React.ReactNode {
  const tokens = marked.lexer(src)
  const tableToken = tokens.find(t => t.type === 'table') as Tokens.Table | undefined
  if (!tableToken) return null

  const headerTexts = tableToken.header.map(cell => cell.text)
  const rowTexts = tableToken.rows.map(row => row.map(cell => cell.text))
  const copyText = [
    `| ${headerTexts.join(' | ')} |`,
    `| ${headerTexts.map(() => '---').join(' | ')} |`,
    ...rowTexts.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')

  return (
    <MarkdownTable isReasoning={isReasoning}>
      <MarkdownTableHeader isReasoning={isReasoning}>
        <MarkdownTableRow isReasoning={isReasoning}>
          {tableToken.header.map((cell, i) => {
            const isLastHeader = i === tableToken.header.length - 1
            return (
              <MarkdownTableCell key={i} isHeader isReasoning={isReasoning}>
                {isLastHeader && copyText && !isReasoning ? (
                  <>
                    <span className="block pr-8">
                      {cell.tokens ? renderInlineTokensToReact(cell.tokens, isReasoning) : cell.text}
                    </span>
                    <span className="absolute inset-y-0 right-0 flex items-center px-2">
                      <CopyButton
                        text={copyText}
                        position="static"
                        className="!p-1 opacity-0 group-hover/table:opacity-100 group-focus-within/table:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
                      />
                    </span>
                  </>
                ) : cell.tokens ? (
                  renderInlineTokensToReact(cell.tokens, isReasoning)
                ) : (
                  cell.text
                )}
              </MarkdownTableCell>
            )
          })}
        </MarkdownTableRow>
      </MarkdownTableHeader>
      <tbody>
        {tableToken.rows.map((row, rowIndex) => (
          <MarkdownTableRow key={rowIndex} isReasoning={isReasoning}>
            {row.map((cell, cellIndex) => (
              <MarkdownTableCell key={cellIndex} isHeader={false} isReasoning={isReasoning}>
                {cell.tokens ? renderInlineTokensToReact(cell.tokens, isReasoning) : cell.text}
              </MarkdownTableCell>
            ))}
          </MarkdownTableRow>
        ))}
      </tbody>
    </MarkdownTable>
  )
}

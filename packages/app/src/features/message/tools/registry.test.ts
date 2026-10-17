import { describe, expect, it } from 'vitest'
import type { PiToolExecution } from '../../../pi/domain/index.js'
import { defaultExtractData, extractToolData, getToolConfig, getToolIcon } from './registry'

describe('defaultExtractData', () => {
  it('extracts files and diagnostics from result details', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        arguments: { filePath: 'src/app.ts' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 0,
        details: {
          files: [
            {
              filePath: 'src/app.ts',
              diff: '@@ -1 +1 @@',
              additions: 1,
              deletions: 1,
            },
          ],
          diagnostics: {
            'src/app.ts': [
              {
                severity: 1,
                message: 'Syntax error',
                range: { start: { line: 3, character: 5 } },
              },
            ],
          },
        },
      },
    }

    const extracted = defaultExtractData(execution)

    expect(extracted.files).toEqual([expect.objectContaining({ filePath: 'src/app.ts', additions: 1, deletions: 1 })])
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({ file: 'app.ts', severity: 'error', line: 3, column: 5 }),
    ])
  })

  it('extracts native bash truncation fields from result details', () => {
    const execution: PiToolExecution = {
      call: {
        type: 'toolCall',
        id: 'call-2',
        name: 'bash',
        arguments: { command: 'make build' },
      },
      result: {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'bash',
        content: [{ type: 'text', text: 'truncated output...' }],
        isError: false,
        timestamp: 0,
        details: {
          truncated: true,
          fullOutputPath: '/tmp/pi-bash-abc.log',
          exitCode: 0,
        },
      },
    }

    const extracted = extractToolData(execution)

    expect(extracted.cwd).toBeUndefined()
    expect(extracted.truncated).toBe(true)
    expect(extracted.fullOutputPath).toBe('/tmp/pi-bash-abc.log')
  })
})

describe('tool registry matching for plugin tools', () => {
  // pi-subagents-lite 注册的是 Agent/StopAgent/MessageAgent/AgentStatus，
  // 不是 OpenCode 的 `task`。四个都要落到 Agent 卡片，否则会掉进 DefaultRenderer。
  it.each(['Agent', 'StopAgent', 'MessageAgent', 'AgentStatus'])('routes %s to the agent card', toolName => {
    const config = getToolConfig(toolName)
    expect(config).toBeDefined()
    // renderer 是 memo() 包装的组件（object），只要求存在
    expect(config?.renderer).toBeDefined()
  })

  it('keeps AgentStatus ahead of the generic search matcher', () => {
    // includes('search','find','grep','glob') 不命中，但 includes('think','reason','plan')
    // 之后的顺序一旦调换，AgentStatus 就会被别的图标抢走。
    const config = getToolConfig('AgentStatus')
    const searchConfig = getToolConfig('web_search')
    expect(config?.icon).not.toEqual(searchConfig?.icon)
  })

  it('does not give plannotator the thinking brain icon', () => {
    // "plannotator" 含 "plan"，会误命中 includes('think','reason','plan')。
    expect(getToolIcon('plannotator')).not.toEqual(getToolIcon('think'))
  })

  it('still matches the OpenCode-style task tool', () => {
    expect(getToolConfig('task')).toBeDefined()
  })
})

import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { loadPiSdk } from '../sdk-host.js'
import { ExtensionUiBridge } from './extension-ui-bridge.js'

before(async () => { await loadPiSdk() })
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Widget snapshot did not update')
}

test('component widgets have persistent mobile snapshots without a terminal viewer', async () => {
  const bridge = new ExtensionUiBridge(() => 'session', () => 'generation')
  let text = 'Todo: first task'
  const widget = () => bridge.getStateMirror().patches.find(patch => patch.kind === 'widget' && patch.key === 'todo')
  try {
    bridge.context.setWidget('todo', (_tui, theme) => ({ render: () => [theme.fg('accent', text)], invalidate() {} }))
    bridge.tuiRedraw()
    await until(() => JSON.stringify(widget()).includes('first task'))
    text = 'Todo: updated task'
    bridge.tuiRedraw()
    await until(() => JSON.stringify(widget()).includes('updated task'))
    for (let i = 0; i < 1000; i++) bridge.context.setStatus('progress', String(i))
    assert.ok(JSON.stringify(widget()).includes('updated task'))
    assert.equal(bridge.getStateMirror().patches.filter(patch => patch.kind === 'widget' && patch.key === 'todo').length, 1)
    bridge.context.setWidget('todo', undefined)
    const removed = widget()
    assert.ok(removed?.kind === 'widget' && removed.lines === undefined)
  } finally { bridge.cancelAll('runtime_disposed') }
})

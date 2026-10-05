import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Component, OverlayHandle } from "@earendil-works/pi-tui"
import { loadPiSdk } from "../sdk-host.js"
import { ExtensionUiBridge, type PiExtensionUiEvent } from "./extension-ui-bridge.js"

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for extension state")
    await delay(10)
  }
}

const panel = (): Component => ({ render: () => ["panel"], invalidate() {} })

describe("extension UI fault boundaries", () => {
  before(async () => { await loadPiSdk() })

  it("quarantines delayed render and dispose failures without leaking exception text", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => "g1")
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    let shouldThrow = false
    let disposed = 0
    try {
      bridge.context.setWidget("good", () => panel())
      bridge.context.setWidget("bad", () => ({
        render() { if (shouldThrow) throw new Error("sentinel-private-text"); return ["initial"] },
        invalidate() {}, dispose() { disposed++; throw new Error("sentinel-private-text") },
      }))
      await waitFor(() => events.some(event => event.type === "tuiFrame" && event.data.includes("initial")))
      shouldThrow = true
      bridge.tuiRedraw()
      await waitFor(() => !bridge.listTuiPanels().some(item => item.key === "bad"))
      assert.equal(disposed, 1)
      assert.ok(bridge.listTuiPanels().some(item => item.key === "good"))
      assert.ok(events.some(event => event.type === "notify" && event.notifyType === "error" && event.message.includes("render")))
      assert.ok(!JSON.stringify(events).includes("sentinel-private-text"))
      bridge.tuiRedraw()
    } finally { bridge.cancelAll("runtime_disposed") }
  })

  it("catches factory and invalidate failures and leaves other widgets mounted", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => undefined)
    try {
      assert.doesNotThrow(() => bridge.context.setWidget("factory", () => { throw new Error("secret") }))
      bridge.context.setWidget("good", () => panel())
      bridge.context.setWidget("invalidate", () => ({ render: () => ["ok"], invalidate() { throw new Error("secret") } }))
      assert.doesNotThrow(() => bridge.context.setTheme("light"))
      await waitFor(() => !bridge.listTuiPanels().some(item => item.key === "invalidate"))
      assert.ok(bridge.listTuiPanels().some(item => item.key === "good"))
      assert.ok(bridge.getStateMirror().patches.some(patch => patch.kind === "status" && patch.text?.includes("factory")))
    } finally { bridge.resetTui() }
  })

  it("forwards overlay visibility, focus and bounds, and settles permanent hide exactly once", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => undefined)
    const handles: OverlayHandle[] = []
    let disposed = 0
    const result = bridge.context.custom<string>(() => ({ ...panel(), dispose() { disposed++ } }), { onHandle: value => handles.push(value) })
    try {
      await waitFor(() => handles.length === 1 && handles[0]!.getBounds() !== undefined)
      const handle = handles[0]!
      assert.equal(handle.isFocused(), true)
      handle.setHidden(true)
      assert.equal(handle.isHidden(), true)
      assert.equal(handle.isFocused(), false)
      handle.setHidden(false)
      handle.focus()
      assert.equal(handle.isFocused(), true)
      handle.unfocus({ target: null })
      assert.equal(handle.isFocused(), false)
      handle.hide()
      handle.hide()
      assert.equal(await result, undefined)
      assert.equal(disposed, 1)
      assert.equal(bridge.listTuiPanels().length, 0)
    } finally { bridge.resetTui() }
  })

  it("cancels factories still awaiting, disposes late results and ignores stale done callbacks", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => undefined)
    let release!: (value: Component & { dispose(): void }) => void
    let oldDone!: (value: string) => void
    let disposed = 0
    const first = bridge.context.custom<string>((_tui, _theme, _keys, done) => {
      oldDone = done
      return new Promise(resolve => { release = resolve })
    })
    const second = bridge.context.custom<string>(() => panel())
    try {
      assert.equal(await first, undefined)
      await waitFor(() => bridge.listTuiPanels().some(item => item.key === "custom"))
      release({ ...panel(), dispose() { disposed++ } })
      oldDone("stale")
      await delay(0)
      assert.equal(disposed, 1)
      assert.equal(bridge.listTuiPanels().length, 1)
      bridge.cancelAll("runtime_reloaded")
      assert.equal(await second, undefined)
    } finally { bridge.resetTui() }
  })

  it("rejects custom input and async factory errors instead of leaving the request pending", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => undefined)
    const input = bridge.context.custom(() => ({ ...panel(), handleInput() { throw new Error("secret-input") } }))
    const rejected = assert.rejects(input, /Extension custom UI failed/)
    try {
      await waitFor(() => bridge.listTuiPanels().length === 1)
      bridge.tuiInput("x")
      await rejected
      assert.equal(bridge.listTuiPanels().length, 0)
      await assert.rejects(bridge.context.custom(async () => { throw new Error("secret-factory") }), /Extension custom UI failed/)
    } finally { bridge.resetTui() }
  })

  it("settles a synchronous done without mounting or disposing twice", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => undefined)
    let disposed = 0
    const value = await bridge.context.custom<string>((_tui, _theme, _keys, done) => {
      done("ok")
      return { ...panel(), dispose() { disposed++ } }
    })
    await delay(0)
    assert.equal(value, "ok")
    assert.equal(disposed, 1)
    assert.equal(bridge.listTuiPanels().length, 0)
  })

  it("drops diagnostic callbacks from the old runtime generation", () => {
    let sessionId = "old"
    const bridge = new ExtensionUiBridge(() => sessionId, () => undefined)
    const report = bridge.captureFailureReporter()
    bridge.cancelAll("session_replaced")
    sessionId = "new"
    report("/private/extensions/old.ts", "session_start")
    assert.equal(bridge.getStateMirror().patches.length, 0)
    bridge.reportFailure("/private/node_modules/@scope/plugin/index.js", "session_start")
    const mirror = JSON.stringify(bridge.getStateMirror())
    assert.ok(mirror.includes("@scope/plugin"))
    assert.ok(!mirror.includes("/private"))
  })

  it("isolates a failing overlay visibility callback", async () => {
    const bridge = new ExtensionUiBridge(() => "a", () => undefined)
    const result = bridge.context.custom(() => panel(), { overlayOptions: { visible() { throw new Error("secret-layout") } } })
    try {
      await assert.rejects(result, /Extension custom UI failed/)
      assert.equal(bridge.listTuiPanels().length, 0)
    } finally { bridge.resetTui() }
  })
})

import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { loadPiSdk } from "../sdk-host.js"
import { ExtensionUiBridge, type PiExtensionUiEvent } from "./extension-ui-bridge.ts"

describe("ExtensionUiBridge", () => {
  before(async () => { await loadPiSdk() })
  it("round-trips blocking dialog responses", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => "generation-1")
    let requestId = ""
    bridge.onEvent(event => {
      if (event.type === "requested") requestId = event.request.requestId
    })
    const selected = bridge.context.select("Choose", ["a", "b"])
    assert.ok(requestId)
    assert.equal(bridge.respond(requestId, { value: "b" }), true)
    assert.equal(await selected, "b")
    assert.equal(bridge.respond(requestId, { value: "a" }), false)
  })

  it("cancels timed out and aborted dialogs", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    assert.equal(await bridge.context.confirm("Confirm", "Continue?", { timeout: 5 }), false)
    assert.equal(events.some(event => event.type === "settled" && event.reason === "timeout"), true)

    const controller = new AbortController()
    const input = bridge.context.input("Input", undefined, { signal: controller.signal })
    controller.abort()
    assert.equal(await input, undefined)
    assert.equal(events.some(event => event.type === "settled" && event.reason === "aborted"), true)
  })

  it("publishes state and keeps a synchronous editor mirror", () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    bridge.context.setStatus("mode", "Planning")
    bridge.context.setWidget("plan", ["1. Inspect"], { placement: "aboveEditor" })
    bridge.context.setEditorText("hello")
    bridge.context.pasteToEditor(" world")
    bridge.context.setToolsExpanded(true)
    assert.equal(bridge.context.setTheme("dark").success, true)
    assert.equal(bridge.context.getEditorText(), "hello world")
    assert.equal(bridge.context.getToolsExpanded(), true)
    assert.equal(events.filter(event => event.type === "state").length, 4)
    assert.equal(events.filter(event => event.type === "editor").length, 2)
  })

  it("degrades terminal-only APIs with one visible warning per capability", () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    let inputCalls = 0
    const unsubscribe = bridge.context.onTerminalInput(() => { inputCalls++ })
    unsubscribe()
    unsubscribe()
    bridge.context.onTerminalInput(() => undefined)
    assert.equal(bridge.context.getEditorComponent(), undefined)
    bridge.context.setEditorComponent(() => { throw new Error("must not instantiate a terminal editor") })
    bridge.context.addAutocompleteProvider(() => undefined as never)
    assert.equal(inputCalls, 0)
    assert.equal(events.filter(event => event.type === "notify").length, 4)
    assert.equal(bridge.getStateMirror().patches.filter(patch => patch.kind === "status").length, 4)
  })

  it("shares live theme references without changing another session", () => {
    const a = new ExtensionUiBridge(() => "a", () => "g1", { getPreferredTheme: () => "dark" })
    const b = new ExtensionUiBridge(() => "b", () => "g1", { getPreferredTheme: () => "dark" })
    const theme = a.context.theme
    const retainedFg = theme.fg
    const original = retainedFg("text", "hello")
    assert.ok(a.context.getAllThemes().some(item => item.name === "light"))
    assert.equal(a.context.getTheme("unknown"), undefined)
    assert.equal(a.context.setTheme("unknown").success, false)
    assert.equal(a.context.setTheme("light").success, true)
    assert.equal(theme, a.context.theme)
    assert.equal(theme.name, "light")
    assert.notEqual(retainedFg("text", "hello"), original)
    assert.equal(b.context.theme.fg("text", "hello"), original)
    assert.equal(a.context.setTheme(a.context.getTheme("dark")!).success, true)
    assert.equal(retainedFg("text", "hello"), original)
  })

  it("uses loaded custom themes and safely falls back for missing preferences", () => {
    const source = new ExtensionUiBridge(() => "source", () => undefined)
    const custom = source.context.getTheme("light")!
    const bridge = new ExtensionUiBridge(() => "session", () => undefined, {
      getThemes: () => [custom], getPreferredTheme: () => "light",
    })
    assert.equal(bridge.context.getTheme("light"), custom)
    assert.equal(bridge.context.theme.fg("accent", "loaded"), custom.fg("accent", "loaded"))
    const missing = new ExtensionUiBridge(() => "missing", () => undefined, { getPreferredTheme: () => "no-such-theme" })
    assert.doesNotThrow(() => missing.context.theme.bold("fallback"))
    assert.ok(missing.getStateMirror().patches.some(patch => patch.kind === "status" && patch.key === "piui-host:theme-fallback"))
  })

  it("renders direct ctx.ui.theme access inside widgets and redraws on theme change", async () => {
    const bridge = new ExtensionUiBridge(() => "session", () => undefined, { getPreferredTheme: () => "dark" })
    let factoryTheme: typeof bridge.context.theme | undefined
    let renders = 0
    bridge.context.setWidget("todo-like", (_tui, theme) => {
      factoryTheme = theme
      return { render: () => { renders++; return [bridge.context.theme.fg("accent", "task")] }, invalidate() {} }
    })
    try {
      assert.equal(factoryTheme, bridge.context.theme)
      bridge.tuiRedraw()
      const before = renders
      bridge.context.setTheme("light")
      assert.ok(renders > before)
    } finally { bridge.resetTui() }
  })

  it("rejects malformed and oversized serializable UI values", () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => undefined)
    bridge.onEvent(() => undefined)
    assert.throws(() => bridge.context.setWidget("bad", ["ok", 1] as never), /at most 500 strings/)
    assert.throws(() => bridge.context.setTitle("x".repeat(4097)), /no longer than 4096/)
    assert.throws(
      () => bridge.context.select("many", Array.from({ length: 201 }, (_, index) => String(index))),
      /at most 200/,
    )
  })

  it("hosts component widgets offscreen and streams ANSI frames", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => "g1")
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    const { Container, Text } = await import("@earendil-works/pi-tui")

    bridge.context.setWidget("panel", (tui, theme) => {
      const container = new Container()
      container.addChild(new Text(theme.fg("accent", "hello panel"), 1, 0))
      return container
    }, { placement: "aboveEditor" })

    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(events.some(event =>
      event.type === "tuiAttach" && event.attach.key === "panel" && event.attach.kind === "widget"))
    assert.ok(events.some(event => event.type === "tuiFrame" && event.data.includes("hello panel")))

    // clearing the widget unmounts the component and emits detach
    bridge.context.setWidget("panel", undefined)
    assert.ok(events.some(event => event.type === "tuiDetach" && event.key === "panel"))
  })

  it("runs custom() components offscreen and resolves through done()", async () => {
    const bridge = new ExtensionUiBridge(() => "session-1", () => "g1")
    const events: PiExtensionUiEvent[] = []
    bridge.onEvent(event => events.push(event))
    const { Container, Text } = await import("@earendil-works/pi-tui")

    const result = bridge.context.custom<number>((tui, theme, keybindings, done) => {
      const container = new Container()
      container.addChild(new Text("custom panel", 1, 0))
      setTimeout(() => done(42), 10)
      return container
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    assert.ok(events.some(event => event.type === "tuiAttach" && event.attach.key === "custom" && event.attach.kind === "custom"))
    assert.equal(await result, 42)
    assert.ok(events.some(event => event.type === "tuiDetach" && event.key === "custom"))
  })
})

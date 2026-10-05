import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Container, Text, type Component } from "@earendil-works/pi-tui"
import type { ExtensionTuiHostEvent } from "./extension-tui.ts"
import { ExtensionTuiHost } from "./extension-tui.ts"

function textWidget(lines: string[]): Component {
  const container = new Container()
  for (const line of lines) container.addChild(new Text(line, 1, 0))
  return container
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for TUI render")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe("ExtensionTuiHost", () => {
  it("mounts a component widget, emits attach, and streams a frame", async () => {
    const events: ExtensionTuiHostEvent[] = []
    const host = new ExtensionTuiHost(event => events.push(event))
    try {
      host.mount("widget", "w1", textWidget(["hello", "world"]))
      // attach is emitted synchronously
      assert.ok(events.some(event => event.type === "attach" && event.attach.key === "w1" && event.attach.kind === "widget"))
      // Wait for content, not the earlier terminal-control frame.
      await waitFor(() => events.some(event => event.type === "frame" && event.data.includes("hello")))
      const frames = events.filter((event): event is Extract<ExtensionTuiHostEvent, { type: "frame" }> => event.type === "frame")
      assert.ok(frames.length >= 1)
      assert.ok(frames.some(frame => frame.data.includes("hello")))
    } finally {
      host.reset()
    }
  })

  it("routes input to the focused custom() component and detaches on close", async () => {
    const events: ExtensionTuiHostEvent[] = []
    const host = new ExtensionTuiHost(event => events.push(event))
    const received: string[] = []
    const interactive = {
      focused: true,
      handleInput(data: string) {
        received.push(data)
      },
      render() {
        return ["panel"]
      },
      invalidate() {
        /* no-op */
      },
    } as Component & { focused: boolean }
    try {
      host.mountCustom(interactive)
      assert.ok(events.some(event => event.type === "attach" && event.attach.key === "custom"))
      await waitFor(() => events.some(event => event.type === "frame" && event.data.includes("panel")))
      host.input("x")
      assert.deepEqual(received, ["x"])
      host.unmountCustom()
      assert.ok(events.some(event => event.type === "detach" && event.key === "custom"))
    } finally {
      host.reset()
    }
  })

  it("resize re-renders at the new size and redraw forces a fresh frame", async () => {
    const events: ExtensionTuiHostEvent[] = []
    const host = new ExtensionTuiHost(event => events.push(event))
    try {
      host.mount("widget", "w1", textWidget(["line"]))
      await waitFor(() => events.some(event => event.type === "frame" && event.data.includes("line")))
      const before = events.filter(event => event.type === "frame").length
      host.resize(40, 5)
      host.redraw()
      await waitFor(() => events.filter(event => event.type === "frame").length > before)
      const frames = events.filter((event): event is Extract<ExtensionTuiHostEvent, { type: "frame" }> => event.type === "frame")
      assert.ok(frames.length >= 2)
    } finally {
      host.reset()
    }
  })
})

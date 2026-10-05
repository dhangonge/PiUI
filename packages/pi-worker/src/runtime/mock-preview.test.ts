import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "node:test"
import type { JsonObject } from "@piui/protocol"
import { MockCatalog, MockPiSession, MockStore } from "./mock-session.js"

it("previews persisted mock history without losing its branch or writing the file", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "piui-mock-preview-"))
  const previous = process.env.PIUI_MOCK_DIR
  process.env.PIUI_MOCK_DIR = home
  let session: MockPiSession | undefined
  try {
    const created = new MockStore().create(home)
    session = await MockPiSession.open(home, created.sessionFile)
    await session.prompt("persisted marker")
    await session.waitForIdle()
    const before = readFileSync(created.sessionFile, "utf8")
    const catalog = new MockCatalog()
    const preview = await catalog.previewSessionById(created.sessionId) as JsonObject
    const branch = preview.branch as JsonObject
    assert.deepEqual(branch.items, session.getBranchPage(undefined, 100, 1_000_000).items)
    assert.equal((branch.items as unknown[]).length, 2)
    assert.equal((preview.state as JsonObject).messageCount, 2)
    const page = await catalog.previewSessionById(created.sessionId, { limit: 1 }) as JsonObject
    assert.equal(((page.branch as JsonObject).items as unknown[]).length, 1)
    assert.equal((page.branch as JsonObject).hasMore, true)
    assert.equal(readFileSync(created.sessionFile, "utf8"), before)
  } finally {
    await session?.dispose()
    if (previous === undefined) delete process.env.PIUI_MOCK_DIR
    else process.env.PIUI_MOCK_DIR = previous
    rmSync(home, { recursive: true, force: true })
  }
})

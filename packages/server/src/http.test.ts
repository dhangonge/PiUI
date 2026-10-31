import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

// Parallel test files each spawn SDK workers; the default handshake budget
// is too tight when several spawn at once on a loaded machine.
process.env.PIUI_WORKER_HANDSHAKE_TIMEOUT_MS ??= '60000'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createAppServer, type AppServer } from './http.ts'
import { PI_PARITY_SDK_VERSION } from '@piui/protocol'

// 测试进程的 session 租约目录放进独立临时目录，跑完即删，
// 不污染默认的 piui-session-leases 命名空间。
const leaseHome = mkdtempSync(path.join(tmpdir(), 'piui-http-leases-'))
process.env.PIUI_SESSION_LEASE_DIR = leaseHome
after(() => {
  rmSync(leaseHome, { recursive: true, force: true })
})

async function listen(app: AppServer) {
  await new Promise<void>((resolve, reject) => {
    app.server.listen(0, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = app.server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  return addr.port
}

async function request(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

/**
 * 裸 http 客户端：fetch/undici 默认自带 accept-encoding 并自动解压，
 * 会把 content-encoding 与线上字节数都藏起来，压缩/304 只能这样测。
 */
async function rawRequest(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          ...headers,
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('http api', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  after(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it('rejects requests without a token and accepts a valid one', async () => {
    const app = createAppServer({ authToken: 'test-token' })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const rejected = await request(port, 'GET', '/api/v1/host/health')
    assert.equal(rejected.status, 401)

    const accepted = await request(port, 'GET', '/api/v1/host/health', { token: 'test-token' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.ok, true)
    assert.equal(accepted.json.service, 'piui-server')
  })

  it('accepts client error reports and rejects malformed ones', async () => {
    const app = createAppServer({ authToken: 'test-token' })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const endpoint = '/api/v1/host/client-log'
    const payload = {
      entries: [
        {
          source: 'react',
          category: 'ui',
          operation: 'render',
          message: 'render exploded',
          appVersion: '0.6.21',
          url: 'https://piui.example/app',
        },
      ],
    }

    // 错误上报也要 token：它会把客户端文本写进 server 日志文件。
    assert.equal((await request(port, 'POST', endpoint, { body: payload })).status, 401)

    const accepted = await request(port, 'POST', endpoint, { body: payload, token: 'test-token' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.accepted, 1)

    const malformed = await request(port, 'POST', endpoint, { body: { entries: 'nope' }, token: 'test-token' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.json.code, 'INVALID_REQUEST')

    const wrongMethod = await request(port, 'GET', endpoint, { token: 'test-token' })
    assert.equal(wrongMethod.status, 405)
  })

  it('serves workspaces, files and git through the host surface', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-http-host-'))
    writeFileSync(path.join(root, 'hello.txt'), 'hello piui', 'utf8')
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const registry = await request(port, 'GET', '/api/v1/host/registry')
    assert.equal(registry.status, 200)
    assert.ok(registry.json.commands.some((command: any) => command.name === 'files.read'))
    assert.ok(registry.json.commands.some((command: any) => command.name === 'git.status'))
    assert.ok(registry.json.commands.some((command: any) => command.name === 'terminals.create'))

    const created = await request(port, 'POST', '/api/v1/host/commands/workspaces.open', { body: { rootPath: root } })
    assert.equal(created.status, 200)
    const workspacePath = created.json.data.workspace.path as string

    const list = await request(port, 'POST', '/api/v1/host/commands/workspaces.list')
    assert.equal(list.status, 200)
    assert.ok(list.json.data.workspaces.some((ws: any) => ws.path === workspacePath))

    const dir = await request(port, 'POST', '/api/v1/host/commands/files.list', { body: { workspacePath, path: '' } })
    assert.equal(dir.status, 200)
    assert.ok(dir.json.data.entries.some((entry: any) => entry.name === 'hello.txt'))

    const read = await request(port, 'POST', '/api/v1/host/commands/files.read', {
      body: { workspacePath, path: 'hello.txt' },
    })
    assert.equal(read.status, 200)
    assert.equal(read.json.data.content, 'hello piui')
    const etag = read.json.data.etag as string
    assert.ok(etag)

    const written = await request(port, 'POST', '/api/v1/host/commands/files.write', {
      body: { workspacePath, path: 'hello.txt', content: 'updated', ifMatch: etag },
    })
    assert.equal(written.status, 200)
    assert.equal(written.json.data.content, 'updated')

    const stale = await request(port, 'POST', '/api/v1/host/commands/files.write', {
      body: { workspacePath, path: 'hello.txt', content: 'stale write', ifMatch: etag },
    })
    assert.equal(stale.status, 409)

    const terminal = await request(port, 'POST', '/api/v1/host/commands/terminals.create', {
      body: { workspacePath, title: 'HTTP terminal', cwd: '' },
    })
    assert.equal(terminal.status, 200)
    const terminalId = terminal.json.data.id as string
    assert.equal(terminal.json.data.status, 'running')

    const terminals = await request(port, 'POST', '/api/v1/host/commands/terminals.list', { body: { workspacePath } })
    assert.equal(terminals.status, 200)
    assert.ok(terminals.json.data.terminals.some((item: any) => item.id === terminalId))

    const renamed = await request(port, 'POST', '/api/v1/host/commands/terminals.update', {
      body: { workspacePath, terminalId, title: 'Renamed terminal', rows: 30, cols: 100 },
    })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.json.data.title, 'Renamed terminal')

    const removed = await request(port, 'POST', '/api/v1/host/commands/terminals.remove', {
      body: { workspacePath, terminalId },
    })
    assert.equal(removed.status, 200)

    const search = await request(port, 'POST', '/api/v1/host/commands/files.searchName', {
      body: { workspacePath, query: 'index' },
    })
    assert.equal(search.status, 200)
    assert.ok(search.json.data.paths.some((p: string) => p.endsWith('index.ts')))

    const gitStatus = await request(port, 'POST', '/api/v1/host/commands/git.status', { body: { workspacePath } })
    assert.equal(gitStatus.status, 200)

    const outside = await request(port, 'POST', '/api/v1/host/commands/files.read', {
      body: { workspacePath, path: '../outside.txt' },
    })
    assert.ok([400, 403, 404].includes(outside.status))

    const oldWorkspaceRoute = await request(port, 'GET', '/api/v1/host/workspaces')
    assert.equal(oldWorkspaceRoute.status, 404)
  })

  it('re-registers a real workspace when the in-memory registry is empty', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-http-reopen-'))
    writeFileSync(path.join(root, 'after-restart.txt'), 'ready', 'utf8')
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const listedBefore = await request(port, 'POST', '/api/v1/host/commands/workspaces.list')
    assert.equal(listedBefore.status, 200)
    assert.deepEqual(listedBefore.json.data.workspaces, [])

    const files = await request(port, 'POST', '/api/v1/host/commands/files.list', {
      body: { workspacePath: root, path: '' },
    })
    assert.equal(files.status, 200)
    assert.ok(files.json.data.entries.some((entry: any) => entry.name === 'after-restart.txt'))

    const listedAfter = await request(port, 'POST', '/api/v1/host/commands/workspaces.list')
    assert.equal(listedAfter.status, 200)
    assert.equal(listedAfter.json.data.workspaces.length, 1)
  })

  it('serves catalog commands and reports unknown commands', async () => {
    const mockHome = mkdtempSync(path.join(tmpdir(), 'piui-http-catalog-'))
    process.env.PIUI_MOCK_DIR = mockHome
    process.env.PIUI_DRIVER = 'mock'
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(mockHome, { recursive: true, force: true })
    })

    const registry = await request(port, 'GET', '/api/v1/pi/registry')
    assert.equal(registry.status, 200)
    assert.equal(registry.json.revision, 1)
    const modelsList = registry.json.globalCommands.find((command: any) => command.name === 'models.list')
    assert.equal(modelsList?.queue, 'immediate')
    assert.equal(modelsList?.idempotent, true)
    assert.ok(registry.json.globalCommands.some((command: any) => command.name === 'session.open'))
    const prompt = registry.json.sessionCommands.find((command: any) => command.name === 'prompt')
    assert.equal(prompt?.paramsSchema.properties.text.type, 'string')
    assert.equal(prompt?.streaming, true)

    const models = await request(port, 'POST', '/api/v1/pi/commands/models.list')
    assert.equal(models.status, 200)
    assert.ok(models.json.data.some((model: any) => model.provider === 'mock'))

    const settings = await request(port, 'POST', '/api/v1/pi/commands/settings.get', { body: { cwd: mockHome } })
    assert.equal(settings.status, 200)

    const created = await request(port, 'POST', '/api/v1/host/commands/workspaces.open', {
      body: { rootPath: mockHome },
    })
    assert.equal(created.status, 200)
    const settingsNow = await request(port, 'POST', '/api/v1/pi/commands/settings.get', { body: { cwd: mockHome } })
    assert.equal(settingsNow.status, 200)
    assert.equal(settingsNow.json.data.workspacePath, mockHome)

    const opened = await request(port, 'POST', '/api/v1/pi/commands/session.open', { body: { cwd: mockHome } })
    assert.equal(opened.status, 200)
    const sessionId = opened.json.data.sessionId as string

    const allSessions = await request(port, 'POST', '/api/v1/pi/commands/session.listAll')
    assert.equal(allSessions.status, 200)
    assert.ok(allSessions.json.data.some((session: any) => session.id === sessionId))

    const preview = await request(port, 'POST', '/api/v1/pi/commands/session.preview', { body: { sessionId } })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.data.state.sessionId, sessionId)
    assert.ok(Array.isArray(preview.json.data.branch.items))

    for (const type of [
      'models.list',
      'settings.patch',
      'trust.set',
      'providers.logout',
      'modelRuntime.setApiKey',
      'packages.manage',
    ]) {
      const globalThroughSession = await request(
        port,
        'POST',
        `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/${type}`,
      )
      assert.equal(globalThroughSession.status, 404, type)
      assert.equal(globalThroughSession.json.code, 'UNKNOWN_COMMAND', type)
    }

    for (const type of ['prompt', 'state.get', 'branch.get']) {
      const sessionThroughGlobal = await request(port, 'POST', `/api/v1/pi/commands/${type}`)
      assert.equal(sessionThroughGlobal.status, 404, type)
      assert.equal(sessionThroughGlobal.json.code, 'UNKNOWN_COMMAND', type)
    }

    const trust = await request(port, 'POST', '/api/v1/pi/commands/trust.get', { body: { cwd: mockHome } })
    assert.equal(trust.status, 200)
    assert.equal(trust.json.data.trusted, true)

    const unknown = await request(port, 'POST', '/api/v1/pi/commands/does.not.exist')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.code, 'UNKNOWN_COMMAND')

    const removedShortcut = await request(port, 'GET', '/api/v1/pi/models')
    assert.equal(removedShortcut.status, 404)
  })

  it('reports the real SDK version and fallback state through health', async () => {
    const hello = {
      kind: 'hello' as const,
      workerProtocolVersion: 3,
      piSdkVersion: '9.9.9',
      piSdkVerified: false,
      piSdkFallback: { source: 'global', message: 'incompatible contract: missing createAgentSessionRuntime' },
      generation: 'gen-1',
      processId: 123,
      heartbeatIntervalMs: 5000,
    }
    const supervisor = {
      onEvent: () => () => {},
      prewarm: async () => {},
      peekCatalogHandshake: async () => hello,
      getCatalogHandshake: async () => hello,
      dispose: async () => {},
    } as unknown as import('./pi/supervisor.ts').RuntimeSupervisor
    const app = createAppServer({ authToken: 'test-token', supervisor })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const health = await request(port, 'GET', '/api/v1/host/health', { token: 'test-token' })
    assert.equal(health.status, 200)
    assert.equal(health.json.piSdkVersion, '9.9.9')
    assert.equal(health.json.piSdkVerified, false)
    assert.deepEqual(health.json.piSdkFallback, {
      source: 'global',
      message: 'incompatible contract: missing createAgentSessionRuntime',
    })
  })

  it('health falls back to the parity constants when the catalog handshake is unavailable', async () => {
    const supervisor = {
      onEvent: () => () => {},
      prewarm: async () => {},
      peekCatalogHandshake: async () => {
        throw new Error('worker crashed')
      },
      getCatalogHandshake: async () => {
        throw new Error('worker crashed')
      },
      dispose: async () => {},
    } as unknown as import('./pi/supervisor.ts').RuntimeSupervisor
    const app = createAppServer({ authToken: 'test-token', supervisor })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const health = await request(port, 'GET', '/api/v1/host/health', { token: 'test-token' })
    assert.equal(health.status, 200)
    assert.equal(health.json.piSdkVersion, PI_PARITY_SDK_VERSION)
    assert.equal(health.json.piSdkVerified, undefined)
    assert.equal(health.json.piSdkFallback, null)
  })

  it('routes extension commands and tools natively through the runtime registry (mock driver)', async () => {
    const mockHome = mkdtempSync(path.join(tmpdir(), 'piui-http-ext-'))
    process.env.PIUI_MOCK_DIR = mockHome
    process.env.PIUI_DRIVER = 'mock'
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(mockHome, { recursive: true, force: true })
    })

    const opened = await request(port, 'POST', '/api/v1/pi/commands/session.open', { body: { cwd: mockHome } })
    assert.equal(opened.status, 200)
    const sessionId = opened.json.data.sessionId as string

    // 扩展命令按名字路由：静态表未命中 → 查 Pi 运行时注册表 → 原生分发。
    const command = await request(
      port,
      'POST',
      `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-command`,
    )
    assert.equal(command.status, 202)
    assert.equal(command.json.command.type, 'mock-command')

    // 注册表里没有的命令仍响亮 404。
    const unknown = await request(
      port,
      'POST',
      `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/does.not.exist`,
    )
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.code, 'UNKNOWN_COMMAND')

    // mock-command 执行后注册了 mock-dynamic-tool：轮询直到按名字可路由，
    // 证明命令真的执行了且注册表是 Pi 运行时自己更新的。
    let dynamic: { status: number } | undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      dynamic = await request(
        port,
        'POST',
        `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-dynamic-tool`,
        { body: { value: 'v1' } },
      )
      if (dynamic.status === 202) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(dynamic?.status, 202)

    // 工具参数 schema 来自 Pi 的工具定义：畸形入参响亮 400，合法入参可路由。
    const badTool = await request(
      port,
      'POST',
      `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-tool`,
      { body: { echo: 42 } },
    )
    assert.equal(badTool.status, 400)
    assert.equal(badTool.json.code, 'INVALID_REQUEST')

    const goodTool = await request(
      port,
      'POST',
      `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/mock-tool`,
      { body: { echo: 'hi' } },
    )
    assert.equal(goodTool.status, 202)
  })
  it('gzip-compresses large JSON for clients that accept it', async () => {
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const plain = await rawRequest(port, 'GET', '/api/v1/host/registry')
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(Number(plain.headers['content-length']), plain.body.length)
    assert.ok(plain.body.length >= 1024, `registry payload too small to exercise gzip: ${plain.body.length}`)

    const compressed = await rawRequest(port, 'GET', '/api/v1/host/registry', { 'accept-encoding': 'gzip, deflate' })
    assert.equal(compressed.status, 200)
    assert.equal(compressed.headers['content-encoding'], 'gzip')
    assert.match(String(compressed.headers.vary), /Accept-Encoding/)
    // content-length 必须是压缩后长度，否则客户端会等不到 body 结束
    assert.equal(Number(compressed.headers['content-length']), compressed.body.length)
    assert.deepEqual(JSON.parse(gunzipSync(compressed.body).toString('utf8')), JSON.parse(plain.body.toString('utf8')))
    assert.ok(compressed.body.length < plain.body.length)
    console.log(
      `[gzip] registry ${plain.body.length} B -> ${compressed.body.length} B (${((compressed.body.length / plain.body.length) * 100).toFixed(1)}%)`,
    )

    // q=0 是显式拒绝，不能被当成接受
    const refused = await rawRequest(port, 'GET', '/api/v1/host/registry', { 'accept-encoding': 'gzip;q=0' })
    assert.equal(refused.headers['content-encoding'], undefined)
    assert.equal(Number(refused.headers['content-length']), refused.body.length)

    // 小响应低于阈值：即便接受 gzip 也不压
    const small = await rawRequest(port, 'GET', '/api/v1/host/health', { 'accept-encoding': 'gzip' })
    assert.equal(small.status, 200)
    assert.equal(small.headers['content-encoding'], undefined)
    assert.ok(small.body.length < 1024)
  })

  it('answers matching If-None-Match with 304 and keeps CORS plus ETag', async () => {
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(() => app.dispose())
    const origin = `http://127.0.0.1:${port}`

    const first = await rawRequest(port, 'GET', '/api/v1/host/registry', { origin })
    assert.equal(first.status, 200)
    const etag = String(first.headers.etag)
    assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/)
    assert.equal(first.headers['cache-control'], 'no-cache')
    assert.equal(first.headers['access-control-allow-origin'], origin)

    const notModified = await rawRequest(port, 'GET', '/api/v1/host/registry', { origin, 'if-none-match': etag })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.body.length, 0)
    assert.equal(notModified.headers.etag, etag)
    // 304 也要能通过浏览器 CORS 校验，否则客户端只会看到网络错误
    assert.equal(notModified.headers['access-control-allow-origin'], origin)
    assert.match(String(notModified.headers.vary), /Origin/)
    assert.equal(notModified.headers['content-length'], undefined)

    // 逗号分隔列表、* 与弱比较（W/）都算命中
    for (const header of [`"nope", ${etag}`, '*', `W/${etag}`]) {
      const cached = await rawRequest(port, 'GET', '/api/v1/host/registry', { 'if-none-match': header })
      assert.equal(cached.status, 304, header)
    }

    // 验证器不等 → 正常 200 带 body
    const revalidated = await rawRequest(port, 'GET', '/api/v1/host/registry', { 'if-none-match': '"stale"' })
    assert.equal(revalidated.status, 200)
    assert.ok(revalidated.body.length > 0)

    // gzip 与明文是两个表示，验证器不共用：拿明文 ETag + accept-encoding: gzip 必须回 200
    const gzipFirst = await rawRequest(port, 'GET', '/api/v1/host/registry', { 'accept-encoding': 'gzip' })
    const gzipEtag = String(gzipFirst.headers.etag)
    assert.equal(gzipEtag, `${etag.slice(0, -1)}-gzip"`)
    for (const [header, status] of [
      [gzipEtag, 304],
      [etag, 200],
    ] as const) {
      const cached = await rawRequest(port, 'GET', '/api/v1/host/registry', {
        'accept-encoding': 'gzip',
        'if-none-match': header,
      })
      assert.equal(cached.status, status, header)
    }

    // POST 命令接口不是幂等读：不发 ETag，也不因 If-None-Match 变 304
    const post = await rawRequest(port, 'POST', '/api/v1/host/commands/workspaces.list', { 'if-none-match': '*' }, {})
    assert.equal(post.status, 200)
    assert.equal(post.headers.etag, undefined)
  })

  it('streams a 12MB file through the download endpoint', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-http-download-'))
    const payload = randomBytes(12 * 1024 * 1024)
    writeFileSync(path.join(root, 'big.bin'), payload)
    const app = createAppServer({ authToken: 'test-token' })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const url = downloadUrl(root, 'big.bin', 'test-token')
    const started = Date.now()
    const res = await rawRequest(port, 'GET', url)
    const elapsedMs = Date.now() - started
    assert.equal(res.status, 200)
    assert.equal(Number(res.headers['content-length']), payload.length)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(res.body.length, payload.length)
    // 抽样比对首/中/尾，避免把整个 12MB 都丢进断言
    for (const offset of [0, payload.length / 2, payload.length - 4096]) {
      assert.ok(res.body.subarray(offset, offset + 4096).equals(payload.subarray(offset, offset + 4096)), `${offset}`)
    }
    console.log(`[download] 12MiB ${res.body.length} bytes in ${elapsedMs}ms via ${res.headers['content-type']}`)
  })

  it('guards the download endpoint with token, disposition and path safety', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-http-download-'))
    writeFileSync(path.join(root, '报告 2024.txt'), '你好 PiUI\n', 'utf8')
    mkdirSync(path.join(root, 'folder'))
    const app = createAppServer({ authToken: 'test-token' })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    // 没 token / 错 token 都拒
    assert.equal((await rawRequest(port, 'GET', downloadUrl(root, '报告 2024.txt'))).status, 401)
    assert.equal((await rawRequest(port, 'GET', downloadUrl(root, '报告 2024.txt', 'wrong'))).status, 401)

    // header token 与 query token 都可
    const viaHeader = await rawRequest(port, 'GET', downloadUrl(root, '报告 2024.txt'), {
      authorization: 'Bearer test-token',
    })
    assert.equal(viaHeader.status, 200)
    assert.equal(viaHeader.body.toString('utf8'), '你好 PiUI\n')
    assert.equal(viaHeader.headers['content-type'], 'text/plain')
    assert.equal(
      viaHeader.headers['content-disposition'],
      `attachment; filename*=UTF-8''${encodeURIComponent('报告 2024.txt')}`,
    )
    assert.match(String(viaHeader.headers['content-disposition']), /filename\*=UTF-8''%E6%8A%A5%E5%91%8A%202024\.txt/)
    const viaQuery = await rawRequest(port, 'GET', downloadUrl(root, '报告 2024.txt', 'test-token'))
    assert.equal(viaQuery.status, 200)

    // 路径逃逸 / 目录 / 不存在 / 缺参数
    const escape = await rawRequest(port, 'GET', downloadUrl(root, '../../etc/passwd', 'test-token'))
    assert.equal(escape.status, 403)
    assert.equal(JSON.parse(escape.body.toString('utf8')).code, 'PATH_OUTSIDE_WORKSPACE')
    const directory = await rawRequest(port, 'GET', downloadUrl(root, 'folder', 'test-token'))
    assert.equal(directory.status, 400)
    assert.equal(JSON.parse(directory.body.toString('utf8')).code, 'INVALID_REQUEST')
    const missing = await rawRequest(port, 'GET', downloadUrl(root, 'nope.txt', 'test-token'))
    assert.equal(missing.status, 404)
    assert.equal(JSON.parse(missing.body.toString('utf8')).code, 'NOT_FOUND')
    const noWorkspace = await rawRequest(
      port,
      'GET',
      `/api/v1/host/files/download?${new URLSearchParams({ path: 'a.txt', token: 'test-token' })}`,
    )
    assert.equal(noWorkspace.status, 400)

    // 只登记 GET：POST 落到 405 而不是 404
    const wrongMethod = await rawRequest(
      port,
      'POST',
      downloadUrl(root, '报告 2024.txt', 'test-token'),
      { authorization: 'Bearer test-token' },
      {},
    )
    assert.equal(wrongMethod.status, 405)
  })
})

function downloadUrl(workspacePath: string, relativePath: string, token?: string): string {
  const params = new URLSearchParams({ workspacePath, path: relativePath })
  if (token !== undefined) params.set('token', token)
  return `/api/v1/host/files/download?${params}`
}

import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { JsonObject, JsonValue } from '@piui/protocol'
import { isJsonObject } from '@piui/protocol'

/**
 * Deep-copy Pi native data into JSON: bigint 转字符串（token 计数会超
 * Number.MAX_SAFE_INTEGER），函数/符号丢弃，Error 保留名称/消息/栈。
 * 原生对象不可改，所以一律走一次 JSON 往返再交给协议层。
 */
export function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
      return item
    }),
  ) as JsonValue
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value)
  if (!isJsonObject(json)) {
    throw Object.assign(new Error('Pi native data is not a JSON object'), { code: 'NATIVE_DATA_NOT_JSON' })
  }
  return json
}

/**
 * message_update 帧里 `assistantMessageEvent.partial` 与 `message` 是同一条
 * 消息的两个副本（客户端只读 `message`），出站前删掉副本，单帧字节量约减半。
 * 只对 JSON 往返后的副本生效——原始 SDK 对象不能改。
 */
export function stripDuplicatePartial(nativeEvent: JsonObject): void {
  if (nativeEvent.type !== 'message_update') return
  const assistantEvent = nativeEvent.assistantMessageEvent
  if (isJsonObject(assistantEvent)) delete assistantEvent.partial
}

export function pathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 会话文件必须落在会话目录里：切会话前挡住目录穿越与仓库外路径。 */
export async function assertSessionFileInside(rootPath: string, sessionFile: string): Promise<void> {
  const root = await realpath(path.resolve(rootPath))
  const target = await realpath(path.resolve(sessionFile))
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
    throw Object.assign(new Error('Pi session file is outside the session directory'), {
      code: 'PATH_OUTSIDE_WORKSPACE',
    })
  }
}

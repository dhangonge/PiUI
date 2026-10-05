import { createHash } from "node:crypto"

export function extensionDiagnostic(source: string, phase: string): { key: string; message: string } {
  const normalized = source.replace(/\\/g, "/")
  const dependency = normalized.split("/node_modules/").at(-1)!
  const parts = dependency.split("/")
  const label = normalized.includes("/node_modules/")
    ? parts.slice(0, dependency.startsWith("@") ? 2 : 1).join("/")
    : parts.at(-1) || "extension"
  const safeLabel = label.replace(/[^a-zA-Z0-9@._/-]/g, "_").slice(0, 96)
  const safePhase = /^[a-z_]{1,48}$/.test(phase) ? phase : "callback"
  const key = createHash("sha256").update(`${source}\0${safePhase}`).digest("hex").slice(0, 16)
  return { key, message: `Extension ${safeLabel} failed during ${safePhase}. Check its server configuration and reload the session after fixing it.` }
}

/** Never put plugin exception text (which may include credentials/prompts) on the diagnostic wire. */
export function extensionActionError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return Object.assign(new Error("Extension action cancelled"), { name: "AbortError", code: "ABORT_ERR" })
  }
  // Preserve the SDK's documented manual nested-call guard, not arbitrary plugin messages.
  if (error instanceof Error && error.message === "No assistant message issued this call") {
    return new Error("No assistant message issued this call")
  }
  return Object.assign(new Error("Extension action failed; see the extension diagnostics"), { code: "INTERNAL_ERROR" })
}

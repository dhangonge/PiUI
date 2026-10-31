# OCUI portable-layer sync for PiUI Android

## Scope and baseline

- Target: this Android-only PiUI fork; retain `app`, `protocol`, `server`, `pi-worker`.
- Reference: OpenCodeUI source `v0.6.35` (`ebdafb2`) to `v0.6.47` (`371cd9c`), 79 non-merge commits. The archived PiUI source matches the OCUI v0.6.35 tree; package version strings alone are not a valid merge base.
- The initial 90-path PORT list was a review queue, not a requirement to restore deleted OpenCode modules. Changes are adapted by behavior, not copied over the Pi-native implementation.
- Original PiUI/OpenCodeUI clones and the separate `ocui-android` fork were not edited during this sync.
- Personal Pi configuration and migration to Pi SDK 1.x are outside this change. Bundled SDK remains 0.84.2.

## Coverage decisions

| OCUI change family                                                   | PiUI Android result                                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown math, escaped/single delimiters, incremental rendering      | Already present in Pi's marked/morphdom pipeline; retained and regression-tested. Duplicate imported tests removed.                                                   |
| Mobile IME delete-all and input-capsule spacing                      | Already present; no second implementation.                                                                                                                            |
| Message animation cancellation                                       | Stop animation controls during cleanup; preserve normal completion and StrictMode safety.                                                                             |
| Streamed timeline derived-data reuse                                 | Retain native ChatArea entry cache and stable maps/sets; OCUI message-part model is incompatible.                                                                     |
| Session-list retries and empty/error states                          | Four attempts, 500/1500/3000ms backoff; loading covers retries; stale work cancelled on unmount, search, directory, endpoint changes. Existing rows survive failures. |
| Parallel servers and composite session identity                      | Explicit HTTP clients, per-server WS streams and raw protocol IDs; composite `serverId::sessionId` only at the UI boundary.                                           |
| Router, sidebar, session tree and child task links                   | Legacy raw routes supported; server-aware navigation, fork linkage, task jump/abort, retained background panes.                                                       |
| Server/folder/chat search and folder ordering                        | Per-server results including saved empty folders; up/down folder controls work on touch screens.                                                                      |
| Subscription/focus churn                                             | Stable subscription snapshots and incremental connection updates; adding B or focusing B does not reconnect A.                                                        |
| Permissions and inline tool requests                                 | Preserve Pi extension UI/TUI and keyed pending actions; do not recreate OpenCode PermissionDialog/usePermissionHandler.                                               |
| Directory, path style, pinned sessions, model visibility/preferences | Server-sharded persistence and snapshots; inactive Windows-path detection does not alter Linux preferences.                                                           |
| Terminal/file/Git panels                                             | Qualified terminal IDs and owner-bound tickets/actions; snapshots keyed by server/endpoint/workspace. File/Git views remount on focused connection changes.           |
| Startup default server and settings                                  | Persist explicit preference separately from the protected built-in local server; backup/import compatible with old data. Preference changes do not switch focus.      |
| First action inside a background pane                                | Capture-phase pointer/focus/click selects the owner before child handlers; navigation context uses the session's own workspace.                                       |
| Storage backup and browser test fixture                              | Export actual `srv:` keys as well as historical backup keys; real JSDOM Storage supports enumeration.                                                                 |
| Dependency and Android CI fixes                                      | fast-uri 3.1.8 override (3.1.6 was still affected by later advisories); install Android platform-tools rather than removed SDK tools package.                         |
| OpenCode update-channel freeze                                       | Deliberately excluded: OpenCode v1 EOL is not evidence of PiUI EOL. PiUI update behavior retained.                                                                    |
| Desktop controls, WSL, Docker, OpenCode SDK/API                      | Excluded from the Android/Pi scope. No desktop runtime, WSL management or OpenCode transport restored.                                                                |

Replaced OCUI-only controllers/view models remain replaced: PiChatPane, native session lists, Pi management pages, and Pi extension stores implement their corresponding responsibilities. Desktop-only guarded components are inert in Android and are not a second supported platform.

## Isolation rules

1. An explicit server binding chooses both URL and credentials before any asynchronous fetch setup. Missing/removed servers fail; tokens never fall back from another server.
2. Endpoint/token edits invalidate that server's pending requests, state and replay cursors. Name-only edits and focus switches do not invalidate bound requests.
3. Global/session commands send raw IDs to the selected backend. Returned command handles carry ownership so polling cannot silently switch backends; non-idempotent POSTs are not automatically replayed.
4. Each WS connection owns subscriptions and replay cursors. Session events are qualified before reaching UI stores, including extensions, live tool output, activity and replacement IDs.
5. Global host/provider/resource controls follow the focused server. The session panes, model choices, pending requests and background activity remain bound independently.
6. Closing a terminal tab addresses its owner even if focus has moved; removing a server or changing its endpoint discards only its cached terminal snapshots.

No Pi wire-protocol change was necessary. Two independent existing backends already provide the required routing boundary.

## Reproducible verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
node --import tsx scripts/smoke-android-ui.mjs
cd packages/app/src-tauri
cargo check
cargo test --lib
```

On memory-constrained machines, the app suite can be run separately with:

```sh
npm run test:run -w @piui/app -- --maxWorkers=1
```

The three Node package scripts quote their test glob so Node, not the Unix shell, expands it. Previously the server/worker root-level tests could be omitted.

The new server integration test runs two actual HTTP/WS servers and two child worker processes with mock agents. It checks equal session/command IDs, credential rejection, per-server messages and independent reconnect replay. Browser smoke runs the built frontend at 412x915, selects and sends to Beta, checks that Alpha received no Beta message, then checks retained split panes and owner selection before child click handlers. Temporary fixtures and browser profiles are removed; no real model invocation is needed.

Tests also now wait for actual async state: initial TUI content, server request arrival, catalog prewarm completion and React effects. Terminal fixtures use a deterministic shell and real command newlines; replay output is permitted between terminal hello and ready.

## Android build and distribution

```sh
export ANDROID_HOME=/path/to/Android/Sdk
export NDK_HOME="$ANDROID_HOME/ndk/28.0.13004108"
cd packages/app
npx tauri android build --apk --target aarch64
# Copy the output before building the next ABI.
npx tauri android build --apk --target armv7
```

Both target commands write the same `gen/android/app/build/outputs/apk/universal/release/` filename. Keep per-ABI copies. Existing generated Android sources include custom activity/theme changes and must not be regenerated with `tauri android init`.

Local release outputs without signing configuration are unsigned. They require signing before installation; CI uses the configured Android release-signing secrets. No production key is created or included by this sync.

## Remaining boundaries

- Backend integration uses mock agents; personal extensions/provider credentials and real model behavior require testing against the user's chosen Pi configuration later.
- Browser mobile emulation and cross-compiled APKs do not replace on-device Android lifecycle/IME/network testing.
- The recorded npm audit after fast-uri repair has 14 remaining findings (8 high, 6 moderate), including SDK/undici and development dependency chains. A forced SDK major upgrade was not performed; this is not a claim of a vulnerability-free dependency tree.
- Node 26 emits upstream localStorage/module-register experimental/deprecation warnings. JSDOM Storage behavior is explicitly tested; these warnings are not suppressed to hide failures.
- Vite still reports chunks above its 500kB warning threshold. The configured vtsls diagnostic request timed out; TypeScript compiler and ESLint provide the completed static checks instead.

## Final run record

Source commit: `2d2f5470` (the subsequent documentation commit does not change app binaries).

| Check                | Result                                                              |
| -------------------- | ------------------------------------------------------------------- |
| App Vitest           | 134 files, 752 passed; final rerun with maxWorkers=1, 349.39s       |
| Protocol Node tests  | 15 passed                                                           |
| Pi worker Node tests | 59 passed                                                           |
| Server Node tests    | 126 passed, 2 pre-existing skips                                    |
| Rust bridge tests    | 3 passed; cargo check also passed                                   |
| Static checks        | All four package typechecks; app ESLint passed                      |
| Production build     | Passed, including both Android before-build Vite runs               |
| Browser smoke        | Three checks passed; screenshot `/tmp/piui-smoke-1791184266643.png` |
| Android release      | arm64-v8a and armeabi-v7a builds exited 0; aapt verified each ABI   |

The Node-package results are from `/tmp/piui-final-suite-VV7YQ7/output.log`. Its app stage exposed one missing React `act` boundary in the existing HTML-touch-control test. After fixing that fixture, the complete app suite passed separately in `/tmp/piui-final-app-DifQop/output.log`; the earlier combined invocation itself did not exit successfully. No application assertion was removed or weakened. The two server skips are Windows-only case renaming on Linux and the already-disabled SessionRuntimeRegistry concurrent-open test.

Final totals: 952 JavaScript/TypeScript tests passed, 2 skipped; 3 additional Rust tests passed. API/browser checks used mock agents; no phone installation or real-LLM test is claimed.

Artifacts are ignored build outputs under `packages/app/src-tauri/target/apk-delivery-2d2f5470/`:

| File                                  | Size in bytes | SHA-256                                                          |
| ------------------------------------- | ------------: | ---------------------------------------------------------------- |
| piui-android-arm64-v8a-unsigned.apk   |      14232685 | edee2a1bd894c10a72b3707eb0e5ea66ce4ef1b30a02df4d671dea9eb2328762 |
| piui-android-armeabi-v7a-unsigned.apk |      11342679 | 70dc6d2e36f435617595cfa1e2ea67245047745d63fc9ac368866ea2bb12e1d9 |

Both declare package `com.piui.app`, versionName `0.6.21`, versionCode `6021`, minSdk `24`, targetSdk `36`. Built with local NDK `28.0.13004108`, Java 21, Rust 1.99.0 and Gradle 8.14.3. Build logs: `/tmp/piui-final-apk-arm64.log`, `/tmp/piui-final-apk-armv7.log`. Unsigned APKs need release or development signing before installation; no private signing material was generated.

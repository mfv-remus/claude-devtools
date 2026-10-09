# Map: Import eval run & session into claude-devtools

Method: wayfinder (summary of github.com/mattpocock/skills, wayfinder/SKILL.md; paraphrased by the fetch tool, not verbatim).
Local markdown tracker. Not committed. Updated after T1-T7 closed.

## Destination
A design + implementation plan detailed enough to build in independent, tested slices.

## Notes
- Deployment target: Docker (`docker-compose.yml`), HTTP mode only in v1. Electron later.
- Fixtures are hand-written and fake. Never commit real traces (they contain internal repo content).
- Sample data: `~/workspace/ai-agent-tools/plugins/mf-sast/evals/results/artifacts/` (local only, claude 2.1.280).
- The eval-run bundle layout (`traces/<case>/<arm>-<n>.jsonl`) is NOT produced by Claude Code; it comes from the user's CI (`summarize.py --traces-out`). It is a claude-devtools-defined format and must be documented as such (T3).

## Decisions so far
1. Scope B: import whole eval run (`results.json` + traces), grouped by case/arm/run; also plain sessions.
2. Storage: copy into `IMPORTS_ROOT` (Docker: `/data/imports`, host `$HOME/.claude-devtools/imports`), survives restarts. Applied in compose/Dockerfile/README (T7, `USER` not added).
3. Input: user picks type first (`eval-run` | `session`), strict layout, single `.zip` (<=200 MB zipped, <=1 GB unzipped, file-count cap). Single-step upload (T5).
4. Eval layout: `results.json` + `traces/<case>/<with|without>-<N>.jsonl`. Session layout: `<sessionId>.jsonl` + optional `<sessionId>/subagents/agent-*.jsonl`.
5. Match runs to traces by index (`arms.<arm>[i]` <-> `<arm>-<i+1>.jsonl`); never use `tracePath`. Missing/extra trace => reject, except runs with `error != null`, and except `partial: true` results (T3). Single-arm cases (no `without`) are valid.
6. Skip `aggregate-result.json` and `report.html` (not copied).
7. `results.json`: `schemaVersion` must be 1, unknown fields ignored, required fields validated with explicit errors. `partial: true` importable, labelled with `partialReason`.
8. Trace reader tolerant: needs at least one `assistant` line, ignores unknown line types, no `claude_code_version` gate (recorded in manifest); banner if `system/init` or `result` missing.
9. Reuse viewer via read-time `EvalTraceAdapter`: drop `thinking_tokens`, synthetic user message from `promptMarkdown`, `tool_result` lines `isMeta: true`, synthesized `parentUuid`, `permission_denied` as annotation (decide in S4). Raw files untouched.
10. Subagent messages inline in traces (`parent_tool_use_id != null`): hidden + banner in v1 (no sample yet).
11. Addressing (T4): import id = UUID v4 (server-generated); `projectId = import:<uuid>` (single `isImportProjectId()`); eval trace session ids are opaque `t001...` mapped in `manifest.json` (case names are labels only, never paths); URLs `/import:<uuid>` (overview) and `/import:<uuid>/<sessionId>`; new tab type `eval-run`; traces open in normal `session` tabs.
12. Virtual project `import:<id>`; only path resolution knows (T2): branch in `buildSessionPath`/`buildSubagentsPath` + strict branch in `validateProjectId` + explicit "resolved path inside IMPORTS_ROOT" check. Imports live OUTSIDE `projectsDir`, so FileWatcher/ProjectScanner/SessionSearcher/notifications skip them for free.
13. Content-derived file reads are triggered by the RENDERER (`sessionDetailSlice.ts:263, 356, 390, 482` -> 4 `/api/read-*` routes), so the gate is in the renderer: skip those calls for `import:*` and show "not available for imports". Server cannot tell by path.
14. Security: Origin/Host check + custom header on write routes, `IMPORTS_READONLY=true`, zip-slip/symlink/bomb guards, temp dir then atomic rename, ids server-generated, own path building from validated parts, `flag: 'wx'`.
15. Libraries (T1): `yauzl` 3.x + `@fastify/multipart`, exact pins. Own checks on top: entry count cap, sum of `uncompressedSize` before extracting, no encrypted entries, no symlinks (Unix mode bits in `externalFileAttributes`), per-entry byte counter, filename whitelist. `@fastify/multipart` needs explicit `fileSize/files/fields/parts` limits and entry in `externalPackages` of `vite.standalone.config.ts`.
16. Metadata: per-import `manifest.json` (id, name, type, createdAt, summary, claudeVersion, schemaVersion, partial, trace id map); list = scan dirs; invalid dirs shown as "invalid" with Delete only.
17. UI (T5, T6): Imports area modelled on `memory`; dialog = type + name + zip, shows ALL validation errors; menu = Rename, Delete (ConfirmDialog), Copy ID, no Reload; `GET /api/imports/capabilities -> {enabled, readonly}`; matrix + failed-first grader header (prototype approved by user, local only). `judgeCostUsd` shown separately. No split view.
18. Electron: later. `ImportService` is transport-agnostic; routes register only when `IMPORTS_ROOT` is set.
19. Cross-session features (global search, notifications, watcher, dashboard, pin/hide) excluded in v1. In-session search, tab restore, deep link included.
20. Tests: fake minimal fixtures; crafted zips generated in test code; convention added to `.claude/rules/testing.md`; manual check against real artifacts, uncommitted.

## Tickets
| ID | Title | Status |
|---|---|---|
| T1 | Zip library + upload transport | done (3 verify items open, below) |
| T2 | Audit `projectId`/`cwd` coupling | done |
| T3 | stream-json format across Claude Code versions | done |
| T4 | `import:<id>` URL/deep-link/validation scheme | done |
| T5 | Import dialog UX | done |
| T6 | Matrix + grader header mockup | done (user approved) |
| T7 | Compose, USER, permissions, docs | done (applied; no USER in Dockerfile) |
| T8 | Harden pre-existing unvalidated read routes (`read-claude-md`, `read-directory-claude-md`, `read-agent-configs`) | NOT opened; user has not decided |

Files: `T1.md` ... `T7.md` in this directory.

## Open verification items (carry into slices)
1. `@fastify/multipart` version compatible with fastify 5 + release dates (npm) - needed before `pnpm add` (S2).
2. Symlink bit test and `validateFileName` behaviour with crafted zips (S1 unit tests).
3. Zips made by macOS Archive Utility open in yauzl? (yauzl README says some are unsupported) - test with a real macOS zip (S1).
4. Does `AgentConfig` returned by `/api/read-agent-configs` include file contents? `ipc/utility.ts` validation not read.
5. Whether `ChunkBuilder`/`SessionParser` merge assistant lines sharing a `message.id` (S4).
6. `ai-sdlc-evals.yml` may use a different trace layout (unchecked).
7. Docker: `UID/GID` need `.env`; first `docker compose up` with `user:` not yet tried; host dir `~/.claude-devtools/imports` must be created first.

## Slices
| Slice | Content | Needs | Status |
|---|---|---|---|
| S1 | `ImportService` core: types, manifest, bundle validators, path-safety helpers, safe unzip | yauzl | done (macOS zip check open) |
| S2 | HTTP routes (list/upload/rename/delete/capabilities), Origin + header check, `IMPORTS_READONLY`, multipart limits | `@fastify/multipart` | done |
| S3 | `import:*` path resolution, validator branch, renderer gate for the 4 read routes | S1 | done |
| S4 | `EvalTraceAdapter` | S1, T3 | done |
| S5 | Renderer: `importSlice`, sidebar, dialog, tab types, deep link in `App.tsx` | S2, S3 | done |
| S6 | `eval-run` tab (matrix) + grader header on session tab; `results` and trace `meta` routes | S4, S5 | done (not checked in a browser) |
| S7 | Docs: README layouts, `.claude/rules/testing.md`, CLAUDE.md audit | all | done |

S1 progress: DONE except the macOS-zip check. `yauzl` 3.4.0 + `@types/yauzl` 3.4.0 installed (exact pins, `--ignore-scripts`; adds only `pend@1.2.0`, already in the tree). 131 tests for `src/main/services/imports/` (full repo: 876 pass), typecheck/eslint/prettier clean.
Files: `src/shared/types/imports.ts`; `src/main/services/imports/{importIds,archivePolicy,bundleValidators,ImportManifest,ImportService,zipArchive,importFromZip,index}.ts`; `test/main/services/imports/*` (incl. `zipFixture.ts`, a test-only zip writer for crafting hostile archives).
`importFromZip(service, {zipPath, type, name})` is the single entry point S2 will call. Flow: name check -> list entries -> archive policy -> layout validation (reads results.json from the zip) -> extract ONLY whitelisted entries to staging -> commit manifest + atomic rename; any failure discards staging (tests assert the root stays empty).
Still open from S1: (a) real macOS Archive Utility zip (open item 3) - needs a file from the user; (b) knip reports `imports/index.ts` unused until S2 imports it (10 other knip findings pre-exist); (c) CRC-32 is not verified by yauzl (accepted: integrity of content is not a security boundary here, the viewer parses JSONL defensively - not yet verified in S4).
Process note: one unapproved read-only npm registry query (`pnpm view yauzl version`) was run before the install approval; result unused.

## Not yet specified
- Inline subagents in eval traces (needs a real sample from the user).
- Pin/hide, Electron support, T8.

## Out of scope
Split view; cross-import search; notifications for imports; file watching; dashboard aggregation (imports are static and not part of live projects).

## Open items after S7
- Real macOS Archive Utility zip (needs a file from the user).
- Whether `AgentConfig` from `/api/read-agent-configs` includes file contents.
- `ai-sdlc-evals.yml` may use a different trace layout (unchecked).
- Inline subagent trace sample (lines are hidden and counted in v1).
- T8: harden the unvalidated read routes.
- No "import no longer exists" message for session tabs of a deleted import.
- knip: `IMPORTS_REQUEST_HEADER` unused; 8 pre-existing eslint errors in S1 tests.
- UI never checked visually in a browser; Docker `.env` UID/GID not tried.

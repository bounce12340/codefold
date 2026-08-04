# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci
npm run typecheck            # tsc --noEmit — the only static gate; no linter is configured
npm run build                # esbuild -> dist/ + copies tree-sitter wasm + regenerates the preview harness
npm run watch                # same builds in watch mode
npm test                     # vitest run (100 tests / 19 files)
npm run test:watch
npx vitest run tests/imports.test.ts          # single file
npx vitest run -t 'resolves relative imports'  # single test by name
npm run preview              # static server for the browser harness at http://127.0.0.1:4173/tools/preview/
npm run preview:verify       # 26 headless scenarios, asserts DOM/CSS invariants
```

`npm test` does not require a prior build. `tests/previewHarness.test.ts` calls
`renderPreviewHtml` from `tools/preview/build.mjs` — the same pure function the build
writes to disk — so it asserts on the bytes the build *would* emit rather than reading the
gitignored `tools/preview/index.html`. Keep it that way: reading the generated file makes
the suite fail spuriously whenever `src/extension.ts` changes without a rebuild (the
defect ROADMAP item 15 recorded).

`npm run preview:verify` needs a real Chromium-based browser and a built `dist/`. It probes
per-platform install paths and `PATH`; set `CODEFOLD_PREVIEW_BROWSER` to an executable path
to override. It launches with `--no-sandbox`, so it works inside containers.

To run the extension itself: F5 in VS Code → **Run CodeFold Extension** (preLaunchTask
runs the build). This repo commits `.vscode/settings.json` with `codefold.openOnStartup:
true`, so the canvas opens automatically in the Extension Development Host; the shipped
default is `false`.

## Architecture

A VS Code extension that renders a workspace as a foldable 2D node canvas. Three esbuild
bundles from one repo: `dist/extension.js` (node/cjs, `vscode` external),
`dist/webview2d.js` (the real 2D UI), and `dist/webview.js` (the frozen 3D showcase).

### Scan → graph → webview

`scanWorkspaceRoot` (`src/scanner/scanWorkspace.ts`) globs `**/*.{ts,tsx,js,jsx,py}` with
gitignore awareness, then feeds two graph builders: `imports.ts` (file nodes + import
edges) and `functions/functionGraph.ts` (function/method nodes + call/contains edges via
`web-tree-sitter` wasm loaded from `dist/tree-sitter/`). The combined `WebviewGraph` is
posted to the webview, which lays out folder groups with `d3-force` using a seed derived
from node/edge ids so positions are stable across reopens.

Node id convention: `path` for files, `path#symbolName` for functions. Multi-root
workspaces prefix both id and display path with `folderName/`. Folder grouping uses only
the **first** path segment (`graph/folders.ts`); top-level files land in `(root)`. Scanning
caps at `MAX_FILES = 2000`.

### State: one writer, four error sources

`NodeStateStore` (`src/state/nodeStateMachine.ts`) is the single owner of node state. It
holds internal signals (an `errorSources` set, `editingAgents`, `humanEditing`, `dirty`,
`verifying`, `passing`) and derives `NodeState` through `resolveNodeState`, whose
precedence is fixed: **error > editing > dirty > verifying > passing > idle**. The webview
only reads state; it never computes it.

Red has four sources that coexist on the same node, each owned by exactly one tracker:

| Source | Tracker | Notes |
|---|---|---|
| `diagnostic` | `DiagnosticTracker` | Only Error severity marks red; Warning does not |
| `test`, `runtime` | `TestRunTracker` (+ `testing/failures.ts`) | Failure stacks mapped to nodes |
| `agent` | `AgentReportTracker` | `agent_report` with `level: 'info'` clears only that agent's report |

Clearing one source must never clear the others — that is what `clearError(ids, source)`
and `replaceErrorSource(source, activeIds)` exist for. Human edits debounce to `dirty`
after `EDITING_DEBOUNCE_MS` (2s).

Import cycles ride along too, but on the **graph** message rather than `stateUpdate` —
`analyzeDependencyHealth` (`graph/dependencyHealth.ts`) is static structure, computed once
per scan. It runs Tarjan iteratively (a recursive one would nest once per file and hit the
JS stack limit at `MAX_FILES`) and looks at **import edges only**: call edges recurse by
design, so including them would report ordinary recursion as a defect. The same edges are
then collapsed onto folders and analysed again — the canvas starts fully collapsed, so a
file-only marking would be invisible by default. Folder analysis counts **only edges that
cross a folder boundary**; both layers share one set of edge keys, so `drawEdges()` marks
them with a single lookup.

Coverage dark zones are deliberately **not** a `NodeState`. `mapCoverageToNodes` returns
`uncoveredNodeIds` alongside the covered ones, which rides to the webview on
`TestRunSnapshot.uncovered` and renders as a `coverage-gap` overlay class. A blind spot can
be idle, dirty or error at the same time, so folding it into the state enum would corrupt
the precedence above. Files absent from the coverage report are never darkened — that means
the tool did not instrument them, which is a different claim from "no test ran this".

### Phase2Runtime wires it together

`createPhase2Runtime` in `src/extension.ts` is the composition root, created per 2D panel
and disposed with it. It owns the FileSystemWatcher, `onDidChangeTextDocument`/`SaveTextDocument`,
the Diagnostics subscription, agent hook event handling, and test runs — funneling
everything into `NodeStateStore` and pushing a single `stateUpdate` message per change.
A closed panel disposes the runtime, but the hook server survives.

Webview → extension messages: `ready`, `loadFunctions`, `saveLayout`, `saveAnnotation`,
`runTests`, `openFile`, `openDiagnostic`, `openTestFailure`. Extension → webview: `graph`,
`functions`, `stateUpdate`, `error`, `testRunError`, `annotationSaved`/`annotationSaveError`,
`layoutSaved`/`layoutSaveError`. Function nodes load lazily per file on `loadFunctions`.

### Agent hook server

`AgentHookServer` (`src/agents/hookServer.ts`) binds only `127.0.0.1` on a random port
with a random token compared using `timingSafeEqual`, accepting `POST /events` only.
Requests are enqueued **at arrival**, before the body is awaited, so concurrent agents are
processed in HTTP arrival order. Events (`agent_edit_start`/`_end`, `agent_report`,
`agent_spawn`, `agent_done`) are validated by `parseAgentHookEvent`; every event needs
`agent_id`.

Start is lazy: activation only registers commands, and the endpoint starts on the first
`CodeFold: Open` / `Open 3D View`, printing URL + token to the **CodeFold** output channel.
It stops only on extension deactivate, so closing the canvas does not drop agent events.

### Persistence

Manual annotations (`.codefold/notes.json`) and card positions (`.codefold/layout.json`)
are written into the **scanned** workspace, not this repo. `auto` annotations are extracted
at scan time from file header comments / Python docstrings (`scanner/annotations.ts`);
`manual` overrides them for display.

### The webview HTML lives inside extension.ts

`get2dWebviewHtml` / `get3dWebviewHtml` are template literals in `src/extension.ts` —
that is where the canvas markup and **all** its CSS live. `tools/preview/build.mjs`
extracts the 2D template by locating those function names and the `return \`` … `` `; ``
boundaries, substituting only `${nonce}` and `${scriptUri}`. Renaming those functions,
adding another placeholder, or changing that return shape breaks both the preview harness
and `tests/previewHarness.test.ts`. `tools/preview/index.html` is generated — never
hand-edit it.

`renderPreviewHtml(extensionSource)` does that whole transform as a pure string function;
`buildPreviewHarness()` is only the read/write wrapper around it. Extend `renderPreviewHtml`
rather than the wrapper, so tests keep covering the transform without touching disk.

## Conventions and constraints

These come from `PROMPT.md` (the project spec) and are not negotiable without asking:

- **Color semantics are fixed**: yellow flash = agent editing, red flash = error, green =
  passing, blue-gray = unknown. Do not repurpose them or add confusable colors. Red/green
  must also differ by shape or icon, not color alone — the state lamp encodes this
  (circle = editing, hollow circle = idle, bar = dirty, triangle = error, square =
  passing), and `assertDistinctShapes()` in `preview:verify` fails the build if two states
  ever collapse to the same colour-independent signature. It checks with
  `codefold.flashAnimations` off too, since that setting removes the animation cue.
- **No frontend framework in the webview** — native DOM + SVG, CSS transitions, `d3-force`
  for layout. No React/Vue/canvas libraries.
- **No silent failures.** Empty catches are banned; parse failures, test command failures,
  and hook errors must surface in the `CodeFold` output channel or the UI.
- **Layout stability**: expanding/collapsing a group must not re-run layout for other
  nodes. `preview:verify` asserts group transforms are byte-identical across all scenarios.
- Respect `prefers-reduced-motion`; both light and dark VS Code themes must stay readable.
- The 3D view is a display-only showcase and is deliberately not connected to the state
  flow. Do not extend it.
- Adding a language means a new `LanguageAdapter` under `src/scanner/functions/`, plus its
  wasm in the copy list in `esbuild.mjs` — the parse layer is adapter-based on purpose.

## Testing

Vitest runs in the `node` environment; `tests/webview2d.dom.test.ts` opts into happy-dom
with a per-file `// @vitest-environment happy-dom` comment and builds a DOM shell by hand.
There is no VS Code at test time — `tests/extensionLifecycle.test.ts` `vi.mock('vscode')`
with a hand-rolled stub. Parse layer, coverage mapping, and state transitions all have
unit tests (`tests/fixtures/` holds sample TS/JS/Python workspaces); keep that coverage
when touching them.

## Documentation

`README.md` is the English source of truth with six translations (`README.{zh-TW,zh-CN,ja,ko,fr,es}.md`).
They are kept structurally identical — same section count, same table rows, same code
fences — so a change to one means updating all seven. `PROMPT.md`, `ROADMAP.md`,
`docs/agent-hooks.md`, and `tools/preview/README.md` are written in Traditional Chinese.
Commit messages follow `type: subject` in Chinese with a detailed body citing verification
output (typecheck/test/build results).

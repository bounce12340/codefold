[English](README.md) (current) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Español](README.es.md)

# CodeFold

CodeFold is a VS Code 2D node canvas for human supervisors. It folds a TS/JS/Python
workspace into folder groups, expands local areas during editing, visualizes coverage
as light flows during testing, and uses fixed state semantics: yellow = editing,
red = error, green = passed, and blue-gray = unknown.

The current core architecture supports:

- Files, functions, class methods, and import/call/contains edges.
- FileSystemWatcher and multi-agent edit/spawn/done/report events.
- VS Code Diagnostics, Vitest/Jest/pytest coverage, and failure stacks.
- Four error sources that can coexist: `test`, `diagnostic`, `runtime`, and `agent`.
- A native DOM + SVG 2D canvas. The 3D view is retained only as a showcase mode;
  open it with **CodeFold: Open 3D View** (`codefold.open3d`).

## Start the development version from scratch

Requirements: VS Code 1.90+, Node.js 18+, npm, and Git.

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

In VS Code, press `F5` and choose **Run CodeFold Extension**. After the new Extension
Development Host opens:

1. Use `File → Open Folder…` to open the TS/JS/Python repo you want to monitor.
2. The 2D canvas opens automatically because this repository commits
   `.vscode/settings.json` with `codefold.openOnStartup` set to `true`. You can still
   run **CodeFold: Open** manually if you close it or need to reopen it. The shipped
   setting defaults to `false`, so ordinary installed workspaces do not open it
   automatically unless the user opts in.
3. After the automatic or manual canvas-open command runs, open `View → Output`,
   select **CodeFold**, and record the `Agent hook endpoint` and `Agent hook token`.
   The endpoint binds only to `127.0.0.1`; retrieve both values again whenever the
   Extension Host restarts.
4. Click a folder title to expand it manually; click a file arrow to expand its
   functions; single-click to inspect the sidebar, and double-click to open the file.

To open the separate 3D showcase, run **CodeFold: Open 3D View**
(`codefold.open3d`). It is display-only and is not connected to the state flow used
by later phases.

You can also validate the canvas in a browser without starting VS Code:

```powershell
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/tools/preview/`.

## Settings

In the Extension Development Host, press `Ctrl+,` and search for `CodeFold`:

| Setting | Default | Purpose |
|---|---:|---|
| `codefold.openOnStartup` | `false` | Boolean; automatically open the 2D canvas when a workspace is loaded |
| `codefold.testCommand.javascript` | empty | When empty, try local Jest according to package.json, then Vitest; never installs packages |
| `codefold.testCommand.python` | empty | When empty, use `python -m coverage run -m pytest` |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Istanbul/c8 JSON path |
| `codefold.testCoverage.python` | `coverage.json` | coverage.py JSON path |
| `codefold.runTestsOnSave` | `false` | Run configured tests after saving; disabled by default because commands can have side effects |
| `codefold.ignorePaths` | `[]` | Additional workspace-relative globs, such as `**/generated/**`; reopen the canvas after changing |
| `codefold.flashAnimations` | `true` | Disable editing/error flashes while preserving static shapes and state colors; also respects reduced motion |

Click **Run tests** in the lower-right corner of the canvas or run
**CodeFold: Run Tests**. The target project must already have its own coverage
provider installed (for example, Vitest coverage, Jest coverage, or coverage.py),
and its command must rewrite the JSON report specified above. CodeFold does not
modify the target project's dependencies.

## Connect agent hooks

With the shipped `codefold.openOnStartup` default of `false`, extension activation
alone does not start the hook server. Run **CodeFold: Open** or
**CodeFold: Open 3D View** first; that first canvas-open command starts the endpoint
and prints its URL and token in **CodeFold** Output. Closing the canvas does not stop
the endpoint; it remains available until the extension deactivates.

The shared bridge is
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs). First, set
the following variables in the **same PowerShell used to start the agent CLI**:

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

The bridge requires Node.js 18+ and reads hook JSON from stdin. Endpoint failures
produce a nonzero exit code instead of being silently ignored. If the agent monitors
a different repo, `CODEFOLD_BRIDGE` must still point to the absolute path of the
bridge inside the CodeFold clone.

### Claude Code

Merge the following into `.claude/settings.local.json` in the monitored repo:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }]
  }
}
```

Restart Claude Code and use `/hooks` to confirm all four hook groups. The official
Claude Code [hooks reference](https://code.claude.com/docs/en/hooks) documents
settings locations, matchers, the stdin event schema, and `shell` as a supported
command-hook field whose `"powershell"` value selects PowerShell on Windows.

> **Do not add an `args` array to these hook entries.** `shell` is ignored whenever
> `args` is set, because exec form bypasses the shell entirely. The entries above
> deliberately use shell form, which is what makes `"shell": "powershell"` take
> effect. Adding `args` would silently disable it.

### Codex CLI

Codex builds that support `/hooks` can use the same lifecycle structure in
`.codex/hooks.json` in the monitored repo. On Windows, use `commandWindows` to
specify the bridge explicitly:

```json
{
  "description": "Report Codex edits and subagents to CodeFold.",
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }]
  }
}
```

Restart Codex CLI, then use `/hooks` to inspect and trust the repo-local hooks. If
your Codex build does not provide `/hooks`, you can still use the localhost endpoint
in the next section; do not assume unsupported lifecycle fields report automatically.

## Test edit, report, and multi-agent lifecycle events directly

The following commands validate the complete data flow without starting an agent:

```powershell
$headers = @{ Authorization = "Bearer $env:CODEFOLD_TOKEN" }

function Send-CodeFoldEvent([hashtable]$Event) {
  $body = $Event | ConvertTo-Json -Compress
  Invoke-RestMethod $env:CODEFOLD_URL -Method Post -Headers $headers `
    -ContentType 'application/json' -Body $body
}

Send-CodeFoldEvent @{
  type='agent_edit_start'; agent_id='main'; agent_name='Claude main'
  node_id='src/index.ts#activate'
}
Send-CodeFoldEvent @{
  type='agent_spawn'; agent_id='worker'; agent_name='Review worker'
  parent_agent_id='main'
}
Send-CodeFoldEvent @{
  type='agent_edit_start'; agent_id='worker'; path='src/extension.ts'
}
Send-CodeFoldEvent @{
  type='agent_report'; agent_id='worker'; path='src/extension.ts'
  message='Response can be sent twice on this branch.'
}
```

When `agent_report` omits `level`, it defaults to error. To clear the same agent's
report on the same target, send `level='info'`; this removes only the `agent` source
and does not clear diagnostic/test/runtime:

```powershell
Send-CodeFoldEvent @{
  type='agent_report'; agent_id='worker'; path='src/extension.ts'
  level='info'; message='Double-send branch resolved.'
}
Send-CodeFoldEvent @{
  type='agent_edit_end'; agent_id='worker'; path='src/extension.ts'
}
Send-CodeFoldEvent @{ type='agent_done'; agent_id='worker' }
Send-CodeFoldEvent @{ type='agent_done'; agent_id='main' }
```

Expected result: the hierarchy first shows main → worker, and the editing node shows
a worker badge. During the report, the node is red and the sidebar lists the agent
and message. After resolution, the red state clears if no other error source remains.
After done, node badges disappear and the status bar's active/editing counts return
to zero. An invalid token should receive HTTP 401, and CodeFold Output should contain
a log entry.

## Smoke checklist from scratch

Follow these items in order to reproduce the complete core-architecture flow:

- [ ] `npm ci`, `npm run typecheck`, `npm run test`, and `npm run build` succeed.
- [ ] Press F5 to open the Extension Development Host; confirm that the development
      workspace setting opens the 2D canvas automatically (or run
      **CodeFold: Open** to reopen it manually).
- [ ] Configure the target project's test command and coverage JSON in Settings,
      then click **Run tests** manually.
- [ ] Send edit/spawn/report/resolve/done as described above and verify the canvas,
      sidebar, badges, and status bar.
- [ ] Install Claude Code or Codex hooks, let the agent edit a real file, and rerun
      the tests.

The last item requires a real VS Code Extension Host and the corresponding agent CLI.
The browser preview validates only the real renderer's visuals and DOM; it does not
replace VS Code Diagnostics, file watching, or the external runner.

For more hook fields and troubleshooting, see
[`docs/agent-hooks.md`](docs/agent-hooks.md). For future directions, see
[`ROADMAP.md`](ROADMAP.md).

## Security and limitations

- The hook server binds only to `127.0.0.1`, uses a random port and a random token on
  every start, and processes requests in HTTP arrival order.
- All features run locally; there is no cloud service dependency.
- The first version supports only TS/JS/TSX/JSX/Python, a single repo, and about
  2,000 files.
- Coverage JSON has no real time order, so the light flow is currently a stable
  approximation; see ROADMAP for details.

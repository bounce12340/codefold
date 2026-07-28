# CodeFold agent hooks

CodeFold 的 2D 視圖啟動後，extension 會在 `127.0.0.1` 的隨機 port 開啟
`/events`，並在 **CodeFold** output channel 顯示 URL 與隨機 token。端點不監聽
LAN 介面；每次 extension host 重啟都應重新取得這兩個值。

先在啟動 agent CLI 的同一個 shell 設定環境變數，讓 hook subprocess 繼承：

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events'
$env:CODEFOLD_TOKEN = '<CodeFold output channel 顯示的 token>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
```

共用 bridge 是 `examples/hooks/codefold-hook.mjs`，需要 Node.js 18 以上。它從
stdin 讀 Claude Code / Codex hook JSON，將 `PreToolUse` 轉成
`agent_edit_start`、`PostToolUse` 轉成 `agent_edit_end`，並將
`SubagentStart` / `SubagentStop` 轉成 `agent_spawn` / `agent_done`。
若 tool input 沒有檔案路徑，bridge 會寫 stderr，FileSystemWatcher 仍會提供
human/unknown 的後備訊號，不會假造函式歸屬。

## Claude Code

在 `.claude/settings.json` 合併下列 `hooks`。`PreToolUse` 讓黃色 editing 狀態在
工具執行前開始；規格要求的 `PostToolUse` 會在成功編修後上報結束。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/examples/hooks/codefold-hook.mjs\""
      }]
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/examples/hooks/codefold-hook.mjs\""
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/examples/hooks/codefold-hook.mjs\""
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/examples/hooks/codefold-hook.mjs\""
      }]
    }]
  }
}
```

Claude Code command hooks 的 JSON 由 stdin 傳入；`Write|Edit` matcher、`tool_input`、
`SubagentStart` 與 `SubagentStop` 的欄位以
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks) 為準。

## Codex CLI

目前 Codex CLI 也支援同名 lifecycle hooks。在 `.codex/hooks.json` 使用相同結構；
Windows 請把下列絕對路徑換成此 repo 的實際位置。Codex 的 `apply_patch` 也接受
`Edit|Write` matcher alias，因此 bridge 會從 patch header 擷取一個或多個檔案。

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

Repo-local hooks 需要信任；在 Codex CLI 用 `/hooks` 檢查並信任目前定義。設定位置、
matcher 與 `commandWindows` 的現行格式見
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)。

## 直接測試端點

所有事件都要有 `agent_id`，`agent_spawn` 還要有 `parent_agent_id`。可用 PowerShell
模擬兩個代理同時編修：

```powershell
$headers = @{ Authorization = "Bearer $env:CODEFOLD_TOKEN" }
$a = @{ type='agent_edit_start'; agent_id='main'; path='src/a.ts' } | ConvertTo-Json
$b = @{ type='agent_spawn'; agent_id='worker'; parent_agent_id='main' } | ConvertTo-Json
Invoke-RestMethod $env:CODEFOLD_URL -Method Post -Headers $headers -ContentType application/json -Body $a
Invoke-RestMethod $env:CODEFOLD_URL -Method Post -Headers $headers -ContentType application/json -Body $b
```

精確到函式時可另帶 `node_id`（例如 `src/a.ts#run`），或帶 1-based `line` /
`symbol`。`agent_report` 必帶 `message`；省略 `level` 或指定
`"level": "error"` 會新增/更新該代理在目標上的 active report 並加入 `agent`
error source。指定 `"level": "info"` 代表該代理確認同一目標已解除，只移除該代理
的 report；若仍有其他代理 report 或 diagnostic/test/runtime，節點會繼續維持 error。

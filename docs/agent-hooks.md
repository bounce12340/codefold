# CodeFold agent hooks

CodeFold 的 2D 視圖啟動後，extension 會在 `127.0.0.1` 的隨機 port 開啟
`/events`，並在 **CodeFold** output channel 顯示 URL 與隨機 token。端點不監聽
LAN 介面；每次 extension host 重啟都應重新取得這兩個值。

先在啟動 agent CLI 的同一個 shell 設定環境變數，讓 hook subprocess 繼承：

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events'
$env:CODEFOLD_TOKEN = '<CodeFold output channel 顯示的 token>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

共用 bridge 是 `examples/hooks/codefold-hook.mjs`，需要 Node.js 18 以上。它從
stdin 讀 Claude Code / Codex hook JSON，將 `PreToolUse` 轉成
`agent_edit_start`、`PostToolUse` 轉成 `agent_edit_end`，並將
`SubagentStart` / `SubagentStop` 轉成 `agent_spawn` / `agent_done`。
若 tool input 沒有檔案路徑，bridge 會寫 stderr，FileSystemWatcher 仍會提供
human/unknown 的後備訊號，不會假造函式歸屬。

## Claude Code

在受監看 repo 的 `.claude/settings.local.json` 合併下列 `hooks`。
`CODEFOLD_BRIDGE` 必須指向 CodeFold clone 內 bridge 的絕對路徑，即使受監看的
是另一個 repo。`PreToolUse` 讓黃色 editing 狀態在工具執行前開始；規格要求的
`PostToolUse` 會在成功編修後上報結束。

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

Claude Code command hooks 的 JSON 由 stdin 傳入。官方
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks) 明列
`shell` 是 command hook 的有效選用欄位，`"powershell"` 會在 Windows 選用
PowerShell；hook subprocess 也會繼承啟動 Claude Code 的環境，因此可讀取
`$env:CODEFOLD_BRIDGE`。`Write|Edit` matcher、`tool_input`、`SubagentStart`
與 `SubagentStop` 的欄位也以該 reference 為準。

> **不要在這些 hook 項目加上 `args` 陣列。** 只要設定了 `args`，`shell` 就會被
> 忽略，因為 exec form 完全繞過 shell。上面的範例刻意採用 shell form，這才是
> `"shell": "powershell"` 生效的原因；加了 `args` 會讓它靜默失效。

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

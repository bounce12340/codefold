[English](README.md) | [繁體中文](README.zh-TW.md)（目前） | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Español](README.es.md)

# CodeFold

CodeFold 是給人類監工使用的 VS Code 2D 節點畫布。它把 TS/JS/Python
workspace 摺疊成資料夾群組；編修時局部展開，測試時以光流呈現 coverage，
並用固定語意顯示狀態：黃色＝編修、紅色＝錯誤、綠色＝通過、灰藍＝未知。

目前主架構支援：

- 檔案、函式、class method 與 import/call/contains 邊。
- FileSystemWatcher 與多代理 edit/spawn/done/report events。
- VS Code Diagnostics、Vitest/Jest/pytest coverage 與 failure stack。
- `test`、`diagnostic`、`runtime`、`agent` 四種可並存的錯誤來源。
- 原生 DOM＋SVG 2D 畫布。3D 視圖僅保留為展示模式；使用
  **CodeFold: Open 3D View**（`codefold.open3d`）開啟。

## 從零啟動開發版

需求：VS Code 1.90+、Node.js 18+、npm、Git。

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

在 VS Code 按 `F5`，選 **Run CodeFold Extension**。新的 Extension Development
Host 開啟後：

1. `File → Open Folder…` 開啟要監看的 TS/JS/Python repo。
2. 這個 repository 提交的 `.vscode/settings.json` 已將
   `codefold.openOnStartup` 設為 `true`，所以 2D 畫布會自動開啟。若關閉後要
   重新開啟，仍可手動執行 **CodeFold: Open**。出貨設定的預設值是 `false`，
   因此一般安裝後的 workspace 不會自動開啟，除非使用者主動啟用。
3. 自動或手動的畫布開啟指令執行後，前往 `View → Output`，選 **CodeFold**，
   記下 `Agent hook endpoint` 與 `Agent hook token`。端點只綁 `127.0.0.1`；
   每次 Extension Host 重啟都要重新取得這兩個值。
4. 點資料夾標題可手動展開；點檔案箭頭展開函式；單擊看側欄，雙擊開檔。

若要開啟獨立的 3D 展示，請執行 **CodeFold: Open 3D View**
（`codefold.open3d`）。它只供展示，不接後續 Phase 使用的狀態流。

也可先用瀏覽器驗收畫布，不啟動 VS Code：

```powershell
npm run build
npm run preview
```

開啟 `http://127.0.0.1:4173/tools/preview/`。

## 設定

在 Extension Development Host 按 `Ctrl+,`，搜尋 `CodeFold`：

| 設定 | 預設 | 用途 |
|---|---:|---|
| `codefold.openOnStartup` | `false` | 布林值；載入 workspace 時自動開啟 2D 畫布 |
| `codefold.testCommand.javascript` | 空白 | 空白時依 package.json 嘗試本地 Jest，否則 Vitest；不會安裝套件 |
| `codefold.testCommand.python` | 空白 | 空白時使用 `python -m coverage run -m pytest` |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Istanbul/c8 JSON 路徑 |
| `codefold.testCoverage.python` | `coverage.json` | coverage.py JSON 路徑 |
| `codefold.runTestsOnSave` | `false` | 存檔後執行設定的測試；因命令可能有副作用所以預設關閉 |
| `codefold.ignorePaths` | `[]` | 額外忽略的 workspace-relative glob，例如 `**/generated/**`；修改後重開畫布 |
| `codefold.flashAnimations` | `true` | 關閉 editing/error 閃爍但保留靜態形狀與狀態色；同時尊重 reduced motion |

按畫布右下的 **Run tests** 或執行 **CodeFold: Run Tests**。目標專案必須已自行
安裝 coverage provider（例如 Vitest coverage、Jest coverage 或 coverage.py），
且命令要重寫上表指定的 JSON report；CodeFold 不會修改目標專案依賴。

## 連接代理 hooks

出貨預設的 `codefold.openOnStartup` 為 `false` 時，只有 extension activation
不會啟動 hook server。請先執行 **CodeFold: Open** 或
**CodeFold: Open 3D View**；第一個畫布開啟指令會啟動端點，並在
**CodeFold** Output 印出 URL 與 token。關閉畫布不會停止端點；它會持續可用，
直到 extension deactivate。

共用 bridge 是
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs)。先在
**啟動代理 CLI 的同一個 PowerShell**設定：

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

bridge 需要 Node.js 18+，從 stdin 讀 hook JSON；任何端點錯誤會以非零 exit code
顯示，不會靜默略過。若代理監看另一個 repo，`CODEFOLD_BRIDGE` 仍要指向 CodeFold
clone 內的 bridge 絕對路徑。

### Claude Code

在受監看 repo 的 `.claude/settings.local.json` 合併：

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

重啟 Claude Code，用 `/hooks` 確認四組 hook。Claude Code 官方
[hooks reference](https://code.claude.com/docs/en/hooks) 說明 settings 位置、
matcher、stdin event schema，以及 `shell` 是受支援的 command-hook 欄位；
其 `"powershell"` 值會在 Windows 選用 PowerShell。

> **不要在這些 hook 項目加上 `args` 陣列。** 只要設定了 `args`，`shell` 就會被
> 忽略，因為 exec form 完全繞過 shell。上面的範例刻意採用 shell form，這才是
> `"shell": "powershell"` 生效的原因；加了 `args` 會讓它靜默失效。

### Codex CLI

支援 `/hooks` 的 Codex build 可在受監看 repo 的 `.codex/hooks.json` 使用相同
lifecycle 結構；Windows 用 `commandWindows` 明確指定 bridge：

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

重啟 Codex CLI，以 `/hooks` 檢查並信任 repo-local hooks。若使用的 Codex build
沒有 `/hooks`，仍可使用下節的 localhost endpoint；不要假設未支援的 lifecycle
欄位會自動上報。

## 直接測試 edit、report 與多代理生命週期

以下命令可在不啟動代理的情況驗證完整資料流：

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

`agent_report` 未指定 `level` 時預設為 error。解除同一代理在同一目標的回報，
傳 `level='info'`；只移除 `agent` source，不會清掉 diagnostic/test/runtime：

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

預期：階層樹先出現 main → worker，編修節點出現 worker 徽章；report 時節點紅色且
側欄列出代理與訊息；resolve 後若無其他 error source 則解除紅色；done 後節點徽章
消失、狀態列活動／編修數歸零。錯誤 token 應得到 HTTP 401，CodeFold Output
留下 log。

## 從零 smoke checklist

依序勾選即可重現主架構全流程：

- [ ] `npm ci`、`npm run typecheck`、`npm run test`、`npm run build` 成功。
- [ ] F5 開啟 Extension Development Host；確認開發 workspace 設定會自動開啟
      2D 畫布（或執行 **CodeFold: Open** 手動重開）。
- [ ] 在 Settings 設定目標專案測試命令與 coverage JSON，手動按 **Run tests**。
- [ ] 依上節送 edit/spawn/report/resolve/done，確認畫布、側欄、徽章及狀態列。
- [ ] 安裝 Claude Code 或 Codex hooks，讓代理實際編修一個檔案，再重做測試。

最後一項需要真實 VS Code Extension Host 與對應代理 CLI；瀏覽器 preview 只能驗證
真實 renderer 的視覺／DOM，不會代替 VS Code Diagnostics、檔案監聽或外部 runner。

更多 hook 欄位與排錯見 [`docs/agent-hooks.md`](docs/agent-hooks.md)，後續方向見
[`ROADMAP.md`](ROADMAP.md)。

## 安全與限制

- hook server 僅綁 `127.0.0.1`、隨機 port、每次啟動隨機 token，並依 HTTP 到達
  順序處理。
- 所有功能本機執行；沒有雲端服務依賴。
- 首版只支援 TS/JS/TSX/JSX/Python、單一 repo 與約 2,000 檔案。
- coverage JSON 沒有真實時間序，光流目前是穩定近似；詳見 ROADMAP。

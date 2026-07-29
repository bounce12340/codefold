[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)（当前） | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Español](README.es.md)

# CodeFold

CodeFold 是供人工监督者使用的 VS Code 2D 节点画布。它将 TS/JS/Python
workspace 折叠成文件夹组；编辑时局部展开，测试时以光流呈现 coverage，
并用固定语义显示状态：黄色＝编辑、红色＝错误、绿色＝通过、灰蓝色＝未知。

当前核心架构支持：

- 文件、函数、class method 以及 import/call/contains 边。
- FileSystemWatcher 和多代理 edit/spawn/done/report events。
- VS Code Diagnostics、Vitest/Jest/pytest coverage 以及 failure stack。
- `test`、`diagnostic`、`runtime`、`agent` 四种可共存的错误来源。
- 原生 DOM＋SVG 2D 画布。3D 视图仅保留为展示模式；使用
  **CodeFold: Open 3D View**（`codefold.open3d`）打开。

## 从零启动开发版

要求：VS Code 1.90+、Node.js 18+、npm、Git。

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

在 VS Code 中按 `F5`，选择 **Run CodeFold Extension**。新的 Extension Development
Host 打开后：

1. 使用 `File → Open Folder…` 打开要监控的 TS/JS/Python repo。
2. 此 repository 提交的 `.vscode/settings.json` 已将
   `codefold.openOnStartup` 设为 `true`，因此 2D 画布会自动打开。关闭后如需
   重新打开，仍可手动运行 **CodeFold: Open**。发布设置的默认值是 `false`，
   因此普通安装后的 workspace 不会自动打开，除非用户主动启用。
3. 自动或手动的画布打开命令运行后，打开 `View → Output`，选择 **CodeFold**，
   记录 `Agent hook endpoint` 和 `Agent hook token`。端点仅绑定
   `127.0.0.1`；每次 Extension Host 重启后都要重新获取这两个值。
4. 单击文件夹标题可手动展开；单击文件箭头展开函数；单击查看侧栏，双击打开文件。

如需打开独立的 3D 展示，请运行 **CodeFold: Open 3D View**
（`codefold.open3d`）。它仅供展示，不接入后续 Phase 使用的状态流。

也可以先用浏览器验收画布，而不启动 VS Code：

```powershell
npm run build
npm run preview
```

打开 `http://127.0.0.1:4173/tools/preview/`。

## 设置

在 Extension Development Host 中按 `Ctrl+,`，搜索 `CodeFold`：

| 设置 | 默认值 | 用途 |
|---|---:|---|
| `codefold.openOnStartup` | `false` | 布尔值；加载 workspace 时自动打开 2D 画布 |
| `codefold.testCommand.javascript` | 空白 | 为空时根据 package.json 尝试本地 Jest，否则尝试 Vitest；不会安装软件包 |
| `codefold.testCommand.python` | 空白 | 为空时使用 `python -m coverage run -m pytest` |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Istanbul/c8 JSON 路径 |
| `codefold.testCoverage.python` | `coverage.json` | coverage.py JSON 路径 |
| `codefold.runTestsOnSave` | `false` | 保存后运行已配置的测试；因为命令可能有副作用，所以默认关闭 |
| `codefold.ignorePaths` | `[]` | 额外忽略的 workspace-relative glob，例如 `**/generated/**`；修改后重新打开画布 |
| `codefold.flashAnimations` | `true` | 关闭 editing/error 闪烁，但保留静态形状和状态颜色；同时尊重 reduced motion |

单击画布右下角的 **Run tests** 或运行 **CodeFold: Run Tests**。目标项目必须已经
自行安装 coverage provider（例如 Vitest coverage、Jest coverage 或 coverage.py），
且命令必须重写上表指定的 JSON report；CodeFold 不会修改目标项目的依赖项。

## 连接代理 hooks

发布设置中 `codefold.openOnStartup` 的默认值为 `false`；仅激活 extension
不会启动 hook server。请先运行 **CodeFold: Open** 或
**CodeFold: Open 3D View**；第一个画布打开命令会启动端点，并在
**CodeFold** Output 中输出 URL 和 token。关闭画布不会停止端点；它会持续可用，
直到 extension 停用。

共用 bridge 是
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs)。请先在
**用于启动代理 CLI 的同一个 PowerShell** 中设置：

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

bridge 需要 Node.js 18+，并从 stdin 读取 hook JSON；任何端点错误都会以非零
exit code 显示，而不会被静默忽略。如果代理监控另一个 repo，`CODEFOLD_BRIDGE`
仍必须指向 CodeFold clone 中 bridge 的绝对路径。

### Claude Code

在受监控 repo 的 `.claude/settings.local.json` 中合并：

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

重启 Claude Code，并使用 `/hooks` 确认四组 hook。Claude Code 官方
[hooks reference](https://code.claude.com/docs/en/hooks) 说明了 settings 位置、
matcher、stdin event schema，以及 `shell` 是受支持的 command-hook 字段；
其 `"powershell"` 值会在 Windows 上选择 PowerShell。

> **不要在这些 hook 条目中添加 `args` 数组。** 只要设置了 `args`，`shell` 就会被
> 忽略，因为 exec form 完全绕过 shell。上面的示例刻意采用 shell form，这才是
> `"shell": "powershell"` 生效的原因；添加 `args` 会让它静默失效。

### Codex CLI

支持 `/hooks` 的 Codex build 可以在受监控 repo 的 `.codex/hooks.json` 中使用
相同的 lifecycle 结构；在 Windows 上使用 `commandWindows` 明确指定 bridge：

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

重启 Codex CLI，使用 `/hooks` 检查并信任 repo-local hooks。如果所用的 Codex
build 没有 `/hooks`，仍可使用下一节中的 localhost endpoint；不要假设不受支持的
lifecycle 字段会自动上报。

## 直接测试 edit、report 和多代理生命周期

以下命令可在不启动代理的情况下验证完整数据流：

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

`agent_report` 未指定 `level` 时默认为 error。要清除同一代理在同一目标上的报告，
请发送 `level='info'`；这只会移除 `agent` source，不会清除
diagnostic/test/runtime：

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

预期结果：层次树先显示 main → worker，编辑节点显示 worker 徽章；report 时节点
变为红色，侧栏列出代理和消息；resolve 后，如果没有其他 error source，红色状态
便会清除；done 后节点徽章消失，状态栏中的活动／编辑计数归零。无效 token 应收到
HTTP 401，CodeFold Output 中应留下 log。

## 从零开始的 smoke checklist

按顺序勾选即可重现核心架构的完整流程：

- [ ] `npm ci`、`npm run typecheck`、`npm run test` 和 `npm run build` 成功。
- [ ] 按 F5 打开 Extension Development Host；确认开发 workspace 设置会自动打开
      2D 画布（或运行 **CodeFold: Open** 手动重新打开）。
- [ ] 在 Settings 中配置目标项目的测试命令和 coverage JSON，然后手动单击
      **Run tests**。
- [ ] 按上一节发送 edit/spawn/report/resolve/done，确认画布、侧栏、徽章和状态栏。
- [ ] 安装 Claude Code 或 Codex hooks，让代理实际编辑一个文件，然后重新测试。

最后一项需要真实的 VS Code Extension Host 和相应的代理 CLI。浏览器 preview
只能验证真实 renderer 的视觉效果／DOM，不能取代 VS Code Diagnostics、文件监控
或外部 runner。

有关更多 hook 字段和故障排除，请参阅
[`docs/agent-hooks.md`](docs/agent-hooks.md)；后续方向请参阅
[`ROADMAP.md`](ROADMAP.md)。

## 安全与限制

- hook server 仅绑定 `127.0.0.1`，使用随机 port，并在每次启动时使用随机 token，
  同时按 HTTP 到达顺序处理请求。
- 所有功能均在本地运行；没有云服务依赖。
- 首个版本仅支持 TS/JS/TSX/JSX/Python、单一 repo 和约 2,000 个文件。
- coverage JSON 没有真实的时间顺序，因此光流目前是稳定的近似表示；详见 ROADMAP。

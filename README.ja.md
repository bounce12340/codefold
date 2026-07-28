[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)（現在） | [한국어](README.ko.md) | [Français](README.fr.md) | [Español](README.es.md)

# CodeFold

CodeFold は、人間の監督者向けの VS Code 2D ノードキャンバスです。TS/JS/Python
workspace をフォルダーグループに折りたたみ、編集中の箇所を部分的に展開し、
テスト時には coverage を光の流れとして可視化します。状態の意味は固定されており、
黄色＝編集中、赤＝エラー、緑＝合格、青みがかった灰色＝不明です。

現在のコアアーキテクチャは、以下をサポートしています。

- ファイル、関数、class method、および import/call/contains エッジ。
- FileSystemWatcher と、複数エージェントの edit/spawn/done/report events。
- VS Code Diagnostics、Vitest/Jest/pytest coverage、および failure stack。
- 同時に存在できる 4 種類のエラーソース：`test`、`diagnostic`、`runtime`、`agent`。
- ネイティブ DOM＋SVG の 2D キャンバス。3D ビューはショーケースモードとしてのみ
  残されており、**CodeFold: Open 3D View**（`codefold.open3d`）で開きます。

## 開発版をゼロから起動する

要件：VS Code 1.90+、Node.js 18+、npm、Git。

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

VS Code で `F5` を押し、**Run CodeFold Extension** を選択します。新しい Extension
Development Host が開いたら、次の手順を実行します。

1. `File → Open Folder…` で監視対象の TS/JS/Python repo を開きます。
2. この repository にコミットされている `.vscode/settings.json` では
   `codefold.openOnStartup` が `true` に設定されているため、2D キャンバスは
   自動的に開きます。閉じた後に再度開く場合は、**CodeFold: Open** を手動で
   実行できます。出荷時の設定値は `false` なので、通常のインストール先 workspace
   では、ユーザーが有効にしない限り自動的に開きません。
3. `View → Output` を開いて **CodeFold** を選択し、`Agent hook endpoint` と
   `Agent hook token` を記録します。エンドポイントは `127.0.0.1` にのみ
   バインドされます。Extension Host を再起動するたびに、両方の値を再取得してください。
4. フォルダー名をクリックすると手動で展開し、ファイルの矢印をクリックすると
   関数を展開します。シングルクリックでサイドバーを確認し、ダブルクリックで
   ファイルを開きます。

独立した 3D ショーケースを開くには、**CodeFold: Open 3D View**
（`codefold.open3d`）を実行します。これは表示専用で、後続 Phase の状態フローには
接続されません。

VS Code を起動せず、先にブラウザーでキャンバスを検証することもできます。

```powershell
npm run build
npm run preview
```

`http://127.0.0.1:4173/tools/preview/` を開きます。

## 設定

Extension Development Host で `Ctrl+,` を押し、`CodeFold` を検索します。

| 設定 | デフォルト | 用途 |
|---|---:|---|
| `codefold.openOnStartup` | `false` | 真偽値。workspace の読み込み時に 2D キャンバスを自動的に開く |
| `codefold.testCommand.javascript` | 空 | 空の場合は package.json に従ってローカルの Jest を試し、次に Vitest を試す。パッケージはインストールしない |
| `codefold.testCommand.python` | 空 | 空の場合は `python -m coverage run -m pytest` を使用する |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Istanbul/c8 JSON のパス |
| `codefold.testCoverage.python` | `coverage.json` | coverage.py JSON のパス |
| `codefold.runTestsOnSave` | `false` | 保存後に設定済みテストを実行する。コマンドに副作用があり得るため、デフォルトでは無効 |
| `codefold.ignorePaths` | `[]` | `**/generated/**` など、追加で無視する workspace-relative glob。変更後はキャンバスを開き直す |
| `codefold.flashAnimations` | `true` | 静的な形状と状態色を保持したまま editing/error の点滅を無効にする。reduced motion にも従う |

キャンバス右下の **Run tests** をクリックするか、**CodeFold: Run Tests** を
実行します。対象プロジェクトには coverage provider（Vitest coverage、Jest
coverage、coverage.py など）があらかじめインストールされている必要があります。
また、コマンドは上表で指定した JSON report を書き換える必要があります。
CodeFold は対象プロジェクトの依存関係を変更しません。

## エージェント hooks を接続する

共通 bridge は
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs) です。まず、
**エージェント CLI を起動するのと同じ PowerShell** で以下を設定します。

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

bridge には Node.js 18+ が必要で、stdin から hook JSON を読み取ります。
エンドポイントのエラーは黙って無視されず、非ゼロの exit code になります。
エージェントが別の repo を監視する場合も、`CODEFOLD_BRIDGE` は CodeFold clone
内の bridge の絶対パスを指す必要があります。

### Claude Code

監視対象 repo の `.claude/settings.local.json` に以下をマージします。

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

Claude Code を再起動し、`/hooks` で 4 つの hook グループを確認します。Claude
Code 公式の [hooks reference](https://code.claude.com/docs/en/hooks) には、
settings の場所、matcher、stdin event schema、および `shell` がサポート対象の
command-hook フィールドであり、値 `"powershell"` が Windows で PowerShell を
選択することが記載されています。

> **これらの hook エントリに `args` 配列を追加しないでください。** `args` を設定
> すると、exec form が shell を完全にバイパスするため `shell` は無視されます。
> 上記の例が意図的に shell form を用いているのは、それによって
> `"shell": "powershell"` が有効になるからです。`args` を追加すると、警告なしに
> 無効化されます。

### Codex CLI

`/hooks` をサポートする Codex build では、監視対象 repo の
`.codex/hooks.json` で同じ lifecycle 構造を使用できます。Windows では
`commandWindows` で bridge を明示します。

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

Codex CLI を再起動し、`/hooks` で repo-local hooks を確認して信頼します。
使用中の Codex build に `/hooks` がない場合でも、次節の localhost endpoint は
使用できます。未サポートの lifecycle フィールドが自動的に報告されるとは
想定しないでください。

## edit、report、複数エージェントのライフサイクルを直接テストする

以下のコマンドで、エージェントを起動せずにデータフロー全体を検証できます。

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

`agent_report` で `level` を省略すると、デフォルトは error です。同じ対象に
対する同じエージェントのレポートを解除するには、`level='info'` を送信します。
これは `agent` source のみを削除し、diagnostic/test/runtime は消去しません。

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

期待結果：階層ツリーに最初に main → worker が表示され、編集中のノードには
worker バッジが表示されます。report 中はノードが赤になり、サイドバーに
エージェントとメッセージが表示されます。resolve 後、ほかの error source が
なければ赤い状態は解除されます。done 後はノードのバッジが消え、ステータスバーの
アクティブ数／編集中数がゼロに戻ります。無効な token には HTTP 401 が返り、
CodeFold Output に log が残るはずです。

## ゼロからの smoke checklist

コアアーキテクチャのフロー全体を再現するには、順番に確認してください。

- [ ] `npm ci`、`npm run typecheck`、`npm run test`、`npm run build` が成功する。
- [ ] F5 で Extension Development Host を開き、開発 workspace の設定によって
      2D キャンバスが自動的に開くことを確認する（または **CodeFold: Open** を
      実行して手動で開き直す）。
- [ ] Settings で対象プロジェクトのテストコマンドと coverage JSON を設定し、
      **Run tests** を手動でクリックする。
- [ ] 前節のとおり edit/spawn/report/resolve/done を送信し、キャンバス、
      サイドバー、バッジ、ステータスバーを確認する。
- [ ] Claude Code または Codex hooks をインストールし、エージェントに実際の
      ファイルを編集させてから、テストを再実行する。

最後の項目には、実際の VS Code Extension Host と対応するエージェント CLI が
必要です。ブラウザー preview で検証できるのは実際の renderer の表示と DOM
だけであり、VS Code Diagnostics、ファイル監視、外部 runner の代わりにはなりません。

hook のその他のフィールドとトラブルシューティングについては
[`docs/agent-hooks.md`](docs/agent-hooks.md)、今後の方向性については
[`ROADMAP.md`](ROADMAP.md) を参照してください。

## セキュリティと制限

- hook server は `127.0.0.1` にのみバインドされ、起動ごとにランダムな port と
  token を使用し、HTTP の到着順にリクエストを処理します。
- すべての機能はローカルで実行され、クラウドサービスへの依存はありません。
- 初版は TS/JS/TSX/JSX/Python、単一 repo、約 2,000 ファイルのみをサポートします。
- coverage JSON には実際の時間順序がないため、光の流れは現在、安定した近似です。
  詳細は ROADMAP を参照してください。

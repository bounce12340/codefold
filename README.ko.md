[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)(현재) | [Français](README.fr.md) | [Español](README.es.md)

# CodeFold

CodeFold는 사람이 감독할 때 사용하는 VS Code 2D 노드 캔버스입니다. TS/JS/Python
workspace를 폴더 그룹으로 접고, 편집 중인 부분을 국소적으로 펼치며, 테스트 중에는
coverage를 빛의 흐름으로 시각화합니다. 상태 의미는 고정되어 있습니다. 노란색＝편집 중,
빨간색＝오류, 초록색＝통과, 청회색＝알 수 없음입니다.

현재 핵심 아키텍처는 다음을 지원합니다.

- 파일, 함수, class method 및 import/call/contains 엣지.
- FileSystemWatcher와 다중 에이전트 edit/spawn/done/report events.
- VS Code Diagnostics, Vitest/Jest/pytest coverage 및 failure stack.
- 동시에 존재할 수 있는 네 가지 오류 소스: `test`, `diagnostic`, `runtime`, `agent`.
- 네이티브 DOM＋SVG 2D 캔버스. 3D 뷰는 쇼케이스 모드로만 유지되며,
  **CodeFold: Open 3D View**(`codefold.open3d`)로 엽니다.

## 개발 버전을 처음부터 시작하기

요구 사항: VS Code 1.90+, Node.js 18+, npm, Git.

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

VS Code에서 `F5`를 누르고 **Run CodeFold Extension**을 선택합니다. 새 Extension
Development Host가 열리면 다음을 수행합니다.

1. `File → Open Folder…`를 사용하여 모니터링할 TS/JS/Python repo를 엽니다.
2. 이 repository에 커밋된 `.vscode/settings.json`에서
   `codefold.openOnStartup`이 `true`로 설정되어 있으므로 2D 캔버스가 자동으로
   열립니다. 닫은 뒤 다시 열어야 한다면 **CodeFold: Open**을 수동으로 실행할 수
   있습니다. 배포 설정의 기본값은 `false`이므로 일반 설치 workspace에서는 사용자가
   직접 활성화하지 않는 한 자동으로 열리지 않습니다.
3. `View → Output`을 열고 **CodeFold**를 선택한 다음 `Agent hook endpoint`와
   `Agent hook token`을 기록합니다. 엔드포인트는 `127.0.0.1`에만 바인딩됩니다.
   Extension Host를 재시작할 때마다 두 값을 다시 가져오십시오.
4. 폴더 제목을 클릭하면 수동으로 펼쳐지고, 파일 화살표를 클릭하면 함수가 펼쳐집니다.
   한 번 클릭하면 사이드바를 확인하고, 두 번 클릭하면 파일을 엽니다.

별도의 3D 쇼케이스를 열려면 **CodeFold: Open 3D View**
(`codefold.open3d`)를 실행하십시오. 이 모드는 표시 전용이며 후속 Phase에서
사용하는 상태 흐름에 연결되지 않습니다.

VS Code를 시작하지 않고 브라우저에서 캔버스를 먼저 검증할 수도 있습니다.

```powershell
npm run build
npm run preview
```

`http://127.0.0.1:4173/tools/preview/`를 엽니다.

## 설정

Extension Development Host에서 `Ctrl+,`를 누르고 `CodeFold`를 검색합니다.

| 설정 | 기본값 | 용도 |
|---|---:|---|
| `codefold.openOnStartup` | `false` | 불리언. workspace를 로드할 때 2D 캔버스를 자동으로 열기 |
| `codefold.testCommand.javascript` | 비어 있음 | 비어 있으면 package.json에 따라 로컬 Jest를 시도한 뒤 Vitest를 시도하며, 패키지를 설치하지 않음 |
| `codefold.testCommand.python` | 비어 있음 | 비어 있으면 `python -m coverage run -m pytest` 사용 |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Istanbul/c8 JSON 경로 |
| `codefold.testCoverage.python` | `coverage.json` | coverage.py JSON 경로 |
| `codefold.runTestsOnSave` | `false` | 저장 후 설정된 테스트를 실행하며, 명령에 부작용이 있을 수 있어 기본적으로 비활성화 |
| `codefold.ignorePaths` | `[]` | `**/generated/**` 같은 추가 workspace-relative glob. 변경 후 캔버스를 다시 열어야 함 |
| `codefold.flashAnimations` | `true` | 정적 모양과 상태 색상을 유지하면서 editing/error 깜박임을 끄며, reduced motion도 따름 |

캔버스 오른쪽 아래의 **Run tests**를 클릭하거나 **CodeFold: Run Tests**를
실행합니다. 대상 프로젝트에는 coverage provider(예: Vitest coverage, Jest
coverage 또는 coverage.py)가 이미 설치되어 있어야 하며, 명령은 위 표에 지정된
JSON report를 다시 작성해야 합니다. CodeFold는 대상 프로젝트의 종속성을 변경하지
않습니다.

## 에이전트 hooks 연결

공용 bridge는
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs)입니다. 먼저
**에이전트 CLI를 시작할 때 사용하는 동일한 PowerShell**에서 다음을 설정합니다.

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

bridge에는 Node.js 18+가 필요하며 stdin에서 hook JSON을 읽습니다. 엔드포인트 오류는
조용히 무시되지 않고 0이 아닌 exit code를 생성합니다. 에이전트가 다른 repo를
모니터링하더라도 `CODEFOLD_BRIDGE`는 CodeFold clone 내부 bridge의 절대 경로를
가리켜야 합니다.

### Claude Code

모니터링할 repo의 `.claude/settings.local.json`에 다음을 병합합니다.

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

Claude Code를 다시 시작하고 `/hooks`로 네 개의 hook 그룹을 확인하십시오. Claude
Code 공식 [hooks reference](https://code.claude.com/docs/en/hooks)는 settings
위치, matcher, stdin event schema를 설명하며, `shell`이 지원되는 command-hook
필드이고 `"powershell"` 값이 Windows에서 PowerShell을 선택한다고 명시합니다.

### Codex CLI

`/hooks`를 지원하는 Codex build는 모니터링할 repo의 `.codex/hooks.json`에서
동일한 lifecycle 구조를 사용할 수 있습니다. Windows에서는 `commandWindows`로
bridge를 명시적으로 지정합니다.

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

Codex CLI를 다시 시작하고 `/hooks`를 사용하여 repo-local hooks를 검사하고
신뢰하십시오. 사용 중인 Codex build에 `/hooks`가 없어도 다음 절의 localhost
endpoint는 사용할 수 있습니다. 지원되지 않는 lifecycle 필드가 자동으로 보고된다고
가정하지 마십시오.

## edit, report 및 다중 에이전트 수명 주기 직접 테스트

다음 명령으로 에이전트를 시작하지 않고 전체 데이터 흐름을 검증할 수 있습니다.

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

`agent_report`에서 `level`을 생략하면 기본값은 error입니다. 동일한 대상에 대한
동일한 에이전트의 보고를 해제하려면 `level='info'`를 전송하십시오. 이렇게 하면
`agent` source만 제거되고 diagnostic/test/runtime은 지워지지 않습니다.

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

예상 결과: 계층 트리에 먼저 main → worker가 나타나고 편집 중인 노드에는 worker
배지가 표시됩니다. report 중에는 노드가 빨간색이 되고 사이드바에 에이전트와 메시지가
표시됩니다. resolve 후 다른 error source가 없다면 빨간색 상태가 해제됩니다. done
후에는 노드 배지가 사라지고 상태 표시줄의 활성／편집 수가 0으로 돌아갑니다. 잘못된
token에는 HTTP 401이 반환되고 CodeFold Output에 log가 남아야 합니다.

## 처음부터 수행하는 smoke checklist

핵심 아키텍처의 전체 흐름을 재현하려면 순서대로 확인하십시오.

- [ ] `npm ci`, `npm run typecheck`, `npm run test`, `npm run build`가 성공한다.
- [ ] F5로 Extension Development Host를 열고 개발 workspace 설정에 의해 2D
      캔버스가 자동으로 열리는지 확인한다(또는 **CodeFold: Open**을 실행하여
      수동으로 다시 연다).
- [ ] Settings에서 대상 프로젝트의 테스트 명령과 coverage JSON을 설정한 뒤
      **Run tests**를 수동으로 클릭한다.
- [ ] 이전 절의 설명대로 edit/spawn/report/resolve/done을 전송하고 캔버스,
      사이드바, 배지 및 상태 표시줄을 확인한다.
- [ ] Claude Code 또는 Codex hooks를 설치하고 에이전트가 실제 파일을 편집하게 한
      뒤 테스트를 다시 실행한다.

마지막 항목에는 실제 VS Code Extension Host와 해당 에이전트 CLI가 필요합니다.
브라우저 preview는 실제 renderer의 시각 요소와 DOM만 검증하며, VS Code
Diagnostics, 파일 감시 또는 외부 runner를 대체하지 않습니다.

추가 hook 필드와 문제 해결 방법은
[`docs/agent-hooks.md`](docs/agent-hooks.md)를, 향후 방향은
[`ROADMAP.md`](ROADMAP.md)를 참조하십시오.

## 보안 및 제한 사항

- hook server는 `127.0.0.1`에만 바인딩되고 시작할 때마다 임의의 port와 token을
  사용하며 HTTP 도착 순서대로 요청을 처리합니다.
- 모든 기능은 로컬에서 실행되며 클라우드 서비스 종속성이 없습니다.
- 첫 번째 버전은 TS/JS/TSX/JSX/Python, 단일 repo 및 약 2,000개의 파일만 지원합니다.
- coverage JSON에는 실제 시간 순서가 없으므로 빛의 흐름은 현재 안정적인
  근사치입니다. 자세한 내용은 ROADMAP을 참조하십시오.

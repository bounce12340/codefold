# CodeFold 2D preview

```powershell
npm run build
npm run preview
```

開啟 `http://127.0.0.1:4173/tools/preview/?scenario=clean`，再用右側
「Preview scenario」選單切換情境。`editing` / `dirty` 對應驗收 1，
`parallel` 對應 2–3，`hierarchy` 對應 4，`conflict` 對應 5；
`error` / `passing` / `status-colors` 用來核對狀態色，`functions` 用來核對
Phase 1 函式節點與 call 邊。Phase 3 可用 `diagnostics` 核對檔案、函式
紅閃與側欄訊息，`diagnostics-warning` 核對 Warning 不染紅，
`diagnostics-multi-source` 核對 error 優先於 editing 且錯誤來源並存。
Phase 4 可用 `verifying` 核對函式與 call 邊的依序光流，
`passing` 核對全綠後群組收合且座標不變，`test-failure` 核對失敗節點
紅閃與側欄 stack trace，`test-mixed` 核對同畫面的通過綠與失敗紅。
Phase 5 可用 `agent-report` 核對代理回報的紅色節點與歸屬，
`all-error-sources` 核對 test / diagnostic / runtime / agent 四種來源，
`status-bar-summary` 核對活動代理、編修、錯誤與通過計數，
`multi-agent-lifecycle` 核對主代理與 subagent 的階層、徽章及完成後清除。
ROADMAP 第 6 項可用 `coverage-gap` 核對測試盲點暗區——該情境刻意讓所有卡片
維持同一個 error 狀態，因此畫面上唯一的差異就是覆蓋率 overlay 本身。
ROADMAP 第 7 項可用 `dependency-health` 核對 import 循環：該情境在既有的
`canvas.ts → edges.ts` 之外補一條反向邊構成真實循環，畫面上同時存在多條
單向 import 邊，因此可確認只有成環的那兩條被標記。該對檔案分屬 `src` 與
`lib`，所以同一個情境也涵蓋群組層——群組卡片標 `↺`、側欄同時列出檔案層
與資料夾層的環。
例如直接開啟：

- `http://127.0.0.1:4173/tools/preview/?scenario=verifying`
- `http://127.0.0.1:4173/tools/preview/?scenario=passing`
- `http://127.0.0.1:4173/tools/preview/?scenario=test-failure`
- `http://127.0.0.1:4173/tools/preview/?scenario=test-mixed`
- `http://127.0.0.1:4173/tools/preview/?scenario=agent-report`
- `http://127.0.0.1:4173/tools/preview/?scenario=all-error-sources`
- `http://127.0.0.1:4173/tools/preview/?scenario=status-bar-summary`
- `http://127.0.0.1:4173/tools/preview/?scenario=multi-agent-lifecycle&step=active`
- `http://127.0.0.1:4173/tools/preview/?scenario=multi-agent-lifecycle&step=done`
- `http://127.0.0.1:4173/tools/preview/?scenario=coverage-gap`
- `http://127.0.0.1:4173/tools/preview/?scenario=dependency-health`

錯誤 token（Phase 2 驗收 6）沒有畫布呈現，仍由
`tests/hookServer.test.ts` 驗證。

## 自動驗收

```powershell
npm run build
npm run preview:verify
```

會以無頭瀏覽器逐一開啟上述 26 個情境，比對 DOM 與計算後的 CSS，並斷言各群組的
`transform` 在所有情境間完全一致（佈局穩定性）。其中 `assertDistinctShapes()`
以「與顏色無關的狀態燈簽章」斷言各狀態形狀互異，包含 `flashAnimations: false`
時的 editing/error/passing——那正是色盲友善約束先前失效的場景。瀏覽器依平台自動尋找
Chrome / Chromium / Edge 的安裝路徑與 `PATH`；若找不到或想指定版本，用
`CODEFOLD_PREVIEW_BROWSER` 指向執行檔絕對路徑：

```bash
CODEFOLD_PREVIEW_BROWSER=/opt/chromium/chrome npm run preview:verify
```

`index.html` 是從 `src/extension.ts` 自動生成，請勿手動編輯。產生它的轉換邏輯是
`tools/preview/build.mjs` 的純函式 `renderPreviewHtml()`，`tests/previewHarness.test.ts`
直接呼叫它，因此跑測試前不需要先 build。

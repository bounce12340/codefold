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
錯誤 token（Phase 2 驗收 6）沒有畫布呈現，仍由
`tests/hookServer.test.ts` 驗證。

`index.html` 是從 `src/extension.ts` 自動生成，請勿手動編輯。

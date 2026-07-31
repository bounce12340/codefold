# CodeFold Roadmap

主架構 Phase 0–5 完成後，以下項目是候選強化方向。難度以目前 TypeScript
extension＋原生 DOM/SVG 架構估算：低（數天）、中（約 1–3 週）、高（跨模組或需
研究/原型驗證）。

## PROMPT.md 預定方向（12 項全數保留）

1. **即時執行追蹤** — 值得做：以 Node `--inspect`、Python `sys.settrace` 讓正式程式運行也能即時發光，完成「活著的程式結構」隱喻。**難度：高**。
2. **更多語言 adapter** — 值得做：Go、Rust、Java 能擴大適用專案，而現有 per-language parser 邊界已可重用。**難度：中（每語言）**。
3. **Git 歷史回放** — 值得做：用時間軸重建結構隨 commit 的演化，方便複盤多代理施工與架構漂移。**難度：高**。
4. **施工錄影（timelapse）** — 值得做：把展開、徽章、光流與收合記錄成可分享的工程稽核影片。**難度：中**。
5. **熱區／技術債熱圖** — 值得做：把頻繁修改與錯誤集中度轉為熱區，協助排定最有價值的重構。**難度：中**。
6. ~~**coverage 缺口暗區**~~ — **已完成**。`mapCoverageToNodes()` 除了 `nodeIds` 與 `sequence`，另回傳 `uncoveredNodeIds`：報告內但零命中的檔案連同其全部函式、以及被命中檔案中未落在任何執行行區間的函式。**未出現在報告中的檔案刻意不算暗區**——那代表工具沒 instrument 它，與「沒有測試走過」是不同的主張，誤標會讓暗區失去意義。暗區以 `TestRunSnapshot.uncovered` 傳到 webview，渲染為 `coverage-gap` overlay class（降低不透明度＋虛線邊框＋降飽和），**不是 NodeState**——盲點可以同時是 idle/dirty/error，因此不得參與狀態優先序。卡片 `aria-label` 併入「not covered by tests」。
7. **依賴健康** — 值得做：循環依賴與過度耦合簇是結構風險，適合直接疊加在既有 import/call graph。**難度：中**。
8. **效能剖析映射** — 值得做：以 profiler 時間驅動節點大小/亮度，可把效能瓶頸和程式結構放在同一張圖。**難度：高**。
9. **從視圖直接指揮代理** — 值得做：從問題節點直接派工可把監控畫布升級成調度台，縮短人類監工迴路。**難度：高**。
10. **戰情室模式** — 值得做：針對大螢幕/投影最佳化資訊密度與自動鏡頭，能支援多代理全局監控。**難度：中至高**。
11. **AI 自動摘要註解** — 值得做：自動維護一句功能摘要能取代暫用的檔頭註解，並降低結構圖的理解門檻。**難度：中**。
12. **3D 蛋白質展示模式復活** — 值得做：把現有 Three.js demo 接回狀態流，適合展示與戰情室，但不取代 2D 主介面。**難度：中至高**。

## 開發過程新增方向

13. **比 coverage 排序更真實的測試事件序列** — 值得做：Istanbul/c8 與 coverage.py 只記錄命中行，目前按檔案＋函式行號穩定排序；結合 reporter 的 test start/end 至少能建立較可信的跨測試順序，即使尚未做完整 tracer。**難度：中**。
14. **獨立檢視器與可分享快照** — 值得做：`tools/preview/` 已證明真實 renderer 可脫離 VS Code；產品化後可提供唯讀分享、CI artifact 或戰情室入口。**難度：中**。
15. ~~**解除 preview 測試與既有 build 產物耦合**~~ — **已完成**。原問題：`tests/previewHarness.test.ts` 讀 `tools/preview/index.html`，改 src 後未 build 會假性失敗，因此每次派工都得附警語提醒先 build。現行為：`tools/preview/build.mjs` 拆出純函式 `renderPreviewHtml(extensionSource)`，`buildPreviewHarness()` 只負責讀檔與寫檔；測試改呼叫同一個 `renderPreviewHtml` 取得 HTML 字串，不讀產物、不寫暫存檔，也不會覆寫真實的 `index.html`。驗證方式：刪除 `tools/preview/index.html` 後直接跑該測試檔仍全綠。
16. ~~**把狀態形狀編碼擴及完整無障礙設計**~~ — **已完成**。原問題（本次檢查實測確認）：PROMPT.md「效能與體驗約束」明列「紅/綠除顏色外需輔以形狀或圖示差異」，但 error 與 passing 的 `border-width`（皆 2px）與狀態燈（皆 8px 圓形）完全相同，唯一的非顏色差異是「有無閃爍動畫」，而該差異會被 `codefold.flashAnimations: false` 直接抹平；`preview:verify` 的 `status-bar-summary` 情境當時量到 editing/error/passing 三者 `animationName` 皆為 `none`、燈的尺寸與圓角全同，只剩 `borderColor` 不同。卡片 `aria-label` 也只帶檔名/語言/路徑，狀態僅存在於狀態燈的 hover `title`。

    現行為：狀態燈改為**形狀承載狀態**，四種狀態的形狀互異且與顏色無關——`editing` 實心圓、`idle` 空心圓、`dirty` 12×5 長條（原有）、`error` 三角形（`clip-path`，呼應 PROMPT 的「尖刺／驚嘆標」）、`passing` 9×9 方形。卡片 `aria-label` 併入狀態與 `errorSources`，讓螢幕閱讀器不必依賴顏色或形狀。`preview.js` 新增與顏色無關的 `lampShape` 簽章（寬/高/圓角/clip-path/實心或空心），`verify.mjs` 新增 `assertDistinctShapes()`，在 `status-colors` 斷言四態形狀互異，並在 `status-bar-summary`（`flashAnimations: false`）斷言 editing/error/passing 形狀互異——正是先前失效的場景。反向驗證：把 error 燈改回圓形後該斷言確實轉紅（`error and editing share the lamp shape 8px/8px/50%/none/solid`）。

    **未涵蓋**：`verifying` 仍是實心圓，與 `editing` 同形（兩者顏色明度差異大且 verifying 帶光流動畫，且非 PROMPT 點名的紅/綠情境）；群組卡片層級的形狀編碼、以及更完整的 ARIA live region 尚未處理，若要做可另立項目。
17. **跨重開的 agent report 持久化與確認流程** — 值得做：目前 active report 屬於畫布 session；持久化、acknowledge/resolve 歷程能避免關閉畫布後遺失尚未處理的 AI 問題。**難度：中**。
18. ~~**agent hook 端點改為 lazy 啟動**~~ — **已完成**。原問題：為支援 `codefold.openOnStartup`，`activationEvents` 含 `onStartupFinished`，因此即使該設定為 `false`，擴充仍會在每次 VS Code 啟動時開啟 localhost 掛勾端點。現行為：activation 只做輕量註冊，第一次執行 `CodeFold: Open` 或 `CodeFold: Open 3D View` 才啟動端點；關閉畫布不停止（保留「畫布未開時仍能接收代理事件」的既有設計），只有 extension deactivate 才停止。

19. ~~**`preview:verify` 只能在 Windows 執行**~~ — **已完成**。原問題：`tools/preview/verify.mjs` 的 `findBrowser()` 只查四個寫死的 Windows 路徑（且用 `readFile` 把整個執行檔讀進記憶體來判斷存在），因此這 23 個情境的驗收在 Linux/macOS 直接拋錯，等於非 Windows 環境無法驗收 2D 畫布。現行為：依 `process.platform` 給候選路徑、掃描 `PATH`、並支援 `CODEFOLD_PREVIEW_BROWSER` 覆寫，存在性改用 `access(X_OK)`。**這是本次檢查新發現的缺陷**，先前未進 roadmap，補上並一併修掉。驗證方式：在 Linux + Chromium 實跑 `preview:verify`，23/23 情境通過、browserExitCodes=0、consoleErrors=0——這是該批情境首次在非 Windows 環境執行。

## 建議優先順序

難度只說明成本，不說明該先做什麼。以下依「投入產出比」分三層，供實際排程參考：

- **第一層｜低成本、痛點已在發生**：（本層已清空）〔6、15、16、18、19 已完成〕
- **第二層｜放大既有投資**：14（獨立檢視器——`tools/preview/` 已證明畫布可脫離 VS Code）、13（測試事件序列）、7（依賴健康，可疊在既有 import/call graph 上）。
- **第三層｜需要研究或跨模組重投入**：1（即時追蹤）、8（效能映射）、3（Git 回放）、9（畫布派工）、10（戰情室）、12（3D 復活）；2（更多語言）與 11（AI 摘要）視實際需求插入。

## 增刪理由

- **未刪除任何 PROMPT.md 預定方向**：12 項都仍符合本機、單 repo、監工畫布的產品定位。
- 新增第 13–16 項，對應 Phase 2–4 實作與驗收實際暴露的限制；它們不是原 12 項的重述，而是可獨立交付的改善。
- 新增第 17 項，因 Phase 5 的 `agent_report` active detail 目前只存於開啟中的 2D runtime；這是刻意維持首版小範圍，但值得在後續補上可靠性。
- 新增第 18 項，因 `codefold.openOnStartup`（commit `888c0af`）為了讓不熟命令面板的使用者能直接看到畫布而加入 `onStartupFinished`，副作用是掛勾端點在設定關閉時仍會常駐。該副作用先前只記錄在 commit 訊息中，未進 roadmap，於本次檢查補上。
- 第 6 與第 15 項的難度標示於本次檢查調整：前者因 Phase 4 已備妥 coverage 映射而下修為「低」，後者補註其為現存缺陷而非未來強化。
- 2026-07-30 檢查：第 15 項已修復（`renderPreviewHtml` 純函式化），並新增第 19 項後一併修復（`preview:verify` 跨平台）。第 16 項依 `preview:verify` 的實測數據從第二層提到第一層——它不是錦上添花的強化，而是 PROMPT.md「色盲友善」約束當時未達成。
- 2026-07-30 後續：第 16 與第 6 項一併完成，第一層因此清空。兩者都只用既有語彙而未新增顏色——第 16 項改的是狀態燈形狀（PROMPT 明訂「不得新增與四大狀態色混淆的顏色」），第 6 項的暗區用不透明度＋虛線邊框而非第五種狀態色，且刻意不進 `NodeState`，以免破壞「狀態機優先序固定、UI 只讀狀態」的既有約束。下一輪的候選改以第二層為主（14、13、7）。
- 未把 TS/JS/Python 以外語言、多機人類協作、Git 回放、即時 tracer 或 3D 狀態流偷偷納入 Phase 5；它們仍維持非目標／後續候選。


# CodeFold — 蛋白質摺疊式 3D 程式結構視覺化 VS Code 外掛（開發 Prompt v1）

## 協作與交付模式

本專案採「主控＋編碼」雙代理分工：

- **主控（orchestrator）＝ Claude**：讀本 prompt、按 Phase 拆解與委派任務、把關驗收。主控不親自寫產品程式碼。
- **編碼＝ Codex CLI**（模型：GPT-5.6 Sol，使用者指定）：接收主控委派的單一 Phase 任務，實作並回報。
- **驗收 gate**：每個 Phase 編碼完成後，主控依照本 prompt 該階段的「人類驗收清單」＋專案設定的測試環節（typecheck、單元測試）逐項實測驗收——可自動驗證的項目由主控實際執行並引用輸出（「跑過了」三個字不算證據），需要主觀判斷的項目（動畫流暢度、視覺效果）呈給人類確認。**驗收未全數通過，退回 Codex 修正；不得進入下一個 Phase，不可跳段、不可合併交付。**
- **版控節奏（使用者核可，2026-07-25）**：本專案放在公開 GitHub repo；**每個 Phase 驗收通過即放一個 commit 並推送**（commit 訊息含階段名＋驗收結果摘要），階段之間的中間狀態不推送。

通用規則：

1. 對規格有疑問或發現矛盾 → 停下來問人類，不要自行猜測後硬做。
2. 想更換技術棧中的任一元件 → 開工前提出替代方案與理由，經人類同意才換。

## 產品一句話

把開發中的程式碼庫呈現為一個 3D「蛋白質」：平時摺疊成緊湊穩定的立體結構；AI 正在編修的部位局部展開成鏈狀並黃色閃爍；跑測試時執行路徑逐節點發光，通過為綠、出錯為紅色閃爍——讓人類監工一眼看出**哪裡在施工、哪裡有問題、哪裡是健康的**，不必逐行讀 diff。

## 核心視覺隱喻（不可偏離）

1. **摺疊態＝穩定**。整個專案預設呈現為緊湊的 3D 摺疊結構（力導向佈局自然收攏成團，相互依賴的模組聚成簇）。
2. **局部展開＝施工中**。只有正在被編修的檔案/函式那一段「鏈」從摺疊結構中局部攤開拉直（像蛋白質局部變性），並以黃色閃爍標示；編修結束且驗證通過後，該段平滑摺疊回原位。整體永遠維持摺疊態，一眼就能看出施工點。
3. **執行發光＝生命跡象**。跑測試時，被執行到的節點沿執行順序依序亮起（類神經訊號傳導的光流效果）；全部通過的節點恆亮綠色，失敗路徑上的節點紅色閃爍。
4. **顏色語意固定**：
   - 黃色閃爍＝AI 正在編修
   - 紅色閃爍＝有錯誤（四種來源見下）
   - 綠色＝驗證通過
   - 中性色（灰藍）＝未知/未驗證
   - 這四種語意不得挪作他用，也不得新增與之混淆的顏色。

## 使用者情境

單人開發者指揮**多個 AI 編碼代理（含主代理派出的 subagent）同時**修改程式碼。開發者不逐行盯 diff，而是看著 3D 視圖：

- 看到某段鏈展開＋黃色閃爍 → 知道有 AI 正在改哪個檔案的哪個函式；節點旁的**代理徽章**分得出是哪一個 agent/subagent 在改
- 多個代理並行時，多處同時局部展開、各掛各的徽章；側欄的代理階層樹（主代理 → subagents）顯示每個代理目前的工作區域與狀態
- AI 改完、測試自動或手動觸發 → 看光流跑過哪些節點
- 出現紅色閃爍 → 點擊該節點，編輯器跳到對應檔案與行號
- 全綠且摺疊回緊湊態 → 這一輪修改可以放心接受

**多代理是一級需求**：同時 N 個代理各自編修不同區域時，視圖必須能並行呈現、互不干擾、可辨識歸屬；兩個代理碰同一個節點時，該節點顯示多重徽章並在側欄標示潛在衝突。

## 支援範圍

- **語言**：TypeScript / JavaScript（含 .tsx/.jsx）＋ Python。架構上解析層要抽象成 per-language adapter，方便日後加語言。
- **節點粒度**：兩層。外層＝檔案節點，點擊展開該檔案的函式/方法/類別子節點；邊＝import 依賴（檔案層）＋函式呼叫關係（函式層，同檔案與跨檔案）。
- **專案規模假設**：單一 repo、本機開發、≤ 約 2000 個檔案。超過門檻時的降級策略見「效能約束」。

## 技術棧（建議）

- VS Code Extension（TypeScript）＋ Webview panel 承載 3D 視圖
- 3D 渲染：Three.js（Webview 內；閃爍用材質 emissive 動畫，不重建幾何體）
- 語法解析：web-tree-sitter（wasm）＋ tree-sitter-typescript / tree-sitter-javascript / tree-sitter-python，抽出函式/類別定義與呼叫、import 語句
- 佈局：3D 力導向（d3-force-3d 或等效自寫）；「展開」動畫＝把目標鏈節點沿一條貝茲曲線拉出結構外，其餘節點位置凍結不重排（位置穩定性優先，避免整團跳動）
- 靜態診斷：VS Code Diagnostics API 彙集現有 linter/type checker（tsc、eslint、Pylance、mypy…）的結果——**不要自己重新實作 lint**
- 測試追蹤：
  - JS/TS：執行使用者在設定中指定的測試指令（預設嘗試 vitest/jest），收 istanbul/c8 的 JSON coverage ＋ 測試 reporter 的失敗 stack trace
  - Python：pytest ＋ coverage.py 的 JSON report
  - coverage 的檔案＋行區間 → 映射到函式節點驅動發光；失敗 stack trace → 對應節點標紅
- 檔案監聽：VS Code FileSystemWatcher（尊重 .gitignore）
- 代理掛勾：extension 在本機開一個 localhost HTTP 端點（僅綁 127.0.0.1，隨機 port，token 驗證），接收 JSON 事件：`agent_edit_start / agent_edit_end / agent_report / agent_spawn / agent_done`，每個事件必帶 `agent_id`，`agent_spawn` 另帶 `parent_agent_id` 以建立 subagent 階層。附 Claude Code hooks 設定範例（PostToolUse 上報編修事件、SubagentStart/Stop 上報 spawn/done）與 Codex CLI 的對應接法說明。多代理並發送事件必須執行緒安全、依到達順序處理

## 資料模型

```ts
type NodeKind = 'file' | 'function';  // function 涵蓋 method/class
type NodeState = 'idle' | 'editing' | 'dirty' | 'verifying' | 'passing' | 'error';

interface GraphNode {
  id: string;            // path#symbolName（檔案節點無 symbol）
  kind: NodeKind;
  path: string;
  name: string;
  range: { startLine: number; endLine: number };
  lang: 'ts' | 'js' | 'py';
  state: NodeState;
  errorSources: Array<'test' | 'diagnostic' | 'runtime' | 'agent'>;  // 紅色的成因，可多個
  editingAgents: string[];         // 正在編修此節點的 agent id 們（空陣列＋檔案有變更＝human/unknown）
  lastVerifiedAt: string | null;
}

interface AgentInfo {
  id: string;            // 掛勾事件自帶；檔案監聽偵測到但無事件者歸為 'unknown'
  name: string;          // 顯示名（如 claude-main、codex-worker-1）
  parentId: string | null;  // subagent 指向派出它的主代理，形成階層樹
  badge: string;         // 系統自動指派的識別徽章（形狀＋輔助色，不佔用四大狀態色語意）
  status: 'active' | 'idle' | 'done';
}

interface GraphEdge {
  from: string;
  to: string;
  kind: 'import' | 'call' | 'contains';
}
```

### 節點狀態機

```
idle ──(檔案變更/agent_edit_start)──▶ editing(展開＋黃閃)
editing ──(變更停止 2s / agent_edit_end)──▶ dirty(展開、暗黃恆亮＝改完未驗證)
dirty ──(測試/診斷開始)──▶ verifying(發光中)
verifying ──(全部訊號源通過)──▶ passing(綠，摺疊回去)
verifying ──(任一訊號源失敗)──▶ error(紅閃，維持展開)
error ──(再次編修)──▶ editing
```

- 紅色判定的四個訊號源，任一觸發即 error：**測試失敗**（失敗測試 stack trace 命中的節點）、**靜態診斷 Error 級**（Diagnostics API）、**執行期錯誤**（測試執行過程拋出的 uncaught exception）、**AI 自行回報**（agent_report 事件標記問題節點）。
- 顯示優先序：`error > editing > dirty > verifying > passing > idle`（一個節點同時滿足多態時取高優先）。
- 側欄需顯示選中節點的狀態與 errorSources 明細（哪個測試失敗、哪條診斷、哪個 agent 回報了什麼）。

## 分階段交付

### Phase 0 — 骨架與摺疊態靜態視圖
extension 啟動、指令面板開啟 3D 面板；掃描 workspace 的 TS/JS/Python 檔案，建檔案層節點與 import 邊；力導向摺疊態呈現、可旋轉/縮放/平移；點節點開對應檔案。

**人類驗收清單**：
1. 在任一 TS 或 Python 專案按 `CodeFold: Open` 能看到 3D 結構，節點數與實際檔案數一致（抽查 3 個）
2. 相互 import 的檔案在空間上確實聚簇（抽查一組已知的模組群）
3. 點擊節點，編輯器開啟正確檔案
4. 旋轉/縮放流暢（主觀不卡頓）

### Phase 1 — 函式層與呼叫邊
tree-sitter 解析函式/類別；點擊檔案節點展開子節點（contains 邊）；同檔案與跨檔案呼叫邊；再點擊收合。

**人類驗收清單**：
1. 挑一個已知內容的檔案展開，函式清單與原始碼一致（無漏、無多）
2. 挑一對已知的呼叫關係（A 函式呼叫 B），視圖中有對應的邊
3. Python 的 class method 正確歸在該檔案下
4. 展開/收合動畫在 300ms 內完成且無跳動

### Phase 2 — 編修偵測：局部展開＋黃色閃爍＋多代理辨識
FileSystemWatcher 監聽變更 → 該檔案（與命中的函式）切到 editing：從摺疊結構局部拉出成鏈、黃色閃爍；停止變更 2 秒轉 dirty（暗黃、維持展開）。同時實作 localhost 代理掛勾端點（含 agent_spawn/agent_done 階層事件）與 Claude Code hooks 範例設定；有掛勾事件的編修在節點旁掛該代理的識別徽章，側欄顯示代理階層樹（主代理 → subagents）與各代理目前工作區域；多代理同時編修不同區域時多處並行展開、互不重排。

**人類驗收清單**：
1. 手動改存一個檔案 → 2 秒內對應節點拉出並黃閃；停止編輯 → 轉暗黃
2. 讓 Claude Code 改一個檔案（裝上 hooks 範例）→ 節點掛徽章、側欄顯示該編修來自哪個代理
3. 用 curl 模擬兩個不同 agent_id 同時編修不同模組 → 兩處各自展開、徽章不同、側欄樹各自歸位，其餘結構位置不動
4. 模擬 agent_spawn 派出 subagent 再編修 → 側欄樹呈現父子階層
5. 兩個代理事件打同一個節點 → 節點顯示多重徽章、側欄標示潛在衝突
6. 掛勾端點用錯誤 token 打 → 被拒絕且 log 有紀錄

### Phase 3 — 靜態診斷紅色標記
訂閱 Diagnostics API；Error 級診斷命中的檔案/函式節點轉 error 紅閃；診斷清除後若無其他錯誤來源則解除。側欄列出診斷訊息，點擊跳到該行。

**人類驗收清單**：
1. 故意寫一個型別錯誤 → 節點紅閃、側欄顯示 tsc/Pylance 訊息、點擊跳到正確行
2. 修好錯誤 → 紅閃解除
3. Warning 級不觸發紅色（維持原狀態）

### Phase 4 — 測試執行追蹤：光流＋紅/綠判定
設定中指定測試指令；執行時收 coverage 與失敗報告；被執行到的節點依序發光（光流動畫），通過轉綠並摺疊回去，失敗路徑紅閃維持展開；測試中拋出的 uncaught exception 也映射為 error。提供「執行測試」按鈕與檔案儲存後自動觸發的開關（預設關）。

**人類驗收清單**：
1. 在測試全綠的專案跑一次 → 光流可見、涉及節點轉綠、結構摺疊回緊湊態
2. 故意弄壞一個函式再跑 → 失敗測試對應節點紅閃、側欄顯示測試名與 stack trace
3. 修好再跑 → 恢復全綠
4. Python 專案（pytest＋coverage.py）重複步驟 1–2 一次

### Phase 5 — AI 回報通道與收尾
agent_report 事件（AI 主動標記問題節點＋訊息）納入 error 來源，並標記來自哪個代理；狀態列摘要（幾個代理活動中/幾個編修中/幾個錯誤/幾個通過）；設定頁（測試指令、忽略路徑、閃爍開關）；README 與 hooks 安裝說明（Claude Code 與 Codex CLI 兩種接法都要涵蓋）。

**人類驗收清單**：
1. 用 curl 模擬 agent_report → 目標節點紅閃、側欄顯示是哪個代理回報了什麼
2. 四種紅色來源在側欄能明確區分
3. 模擬「主代理＋兩個 subagent 並行工作到完成」的完整事件序列 → 階層樹、徽章、狀態流轉全程正確，agent_done 後徽章消失
4. 照 README 從零安裝設定一遍，全流程可跑通

## 非目標（第一版不做，寫進 roadmap 即可）

- 正式環境/長駐程式的即時執行追蹤（sys.settrace / --inspect 即時發光）——列為 Phase 6+ 候選
- TS/JS/Python 以外的語言
- 多「人類」協作（多台機器共視同一視圖）、遠端 workspace——注意：多 AI 代理並行是一級需求（見上），不在此排除之列
- Git 歷史回放動畫
- 任何雲端服務依賴——一切本機運行

## 主架構完成後的強化方向（Phase 5 收尾時必須落檔）

**Phase 5 驗收前，必須在 repo 根目錄建立 `ROADMAP.md`**，內容＝下列預定方向＋開發過程中實際發現的新強化點（每項附一句「為什麼值得做」與大致難度）。這是交付物的一部分，不是選配。

預定方向（草擬時已知，屆時可增刪但須留下理由）：

1. **即時執行追蹤**：跳脫測試情境，程式真實運行時掛 tracer（Node `--inspect`、Python `sys.settrace`）即時發光——「活著的蛋白質」完全體
2. **更多語言 adapter**：Go / Rust / Java（解析層已抽象成 per-language adapter，逐語言擴充）
3. **Git 歷史回放**：時間軸拖桿看結構隨 commit 演化的摺疊/生長動畫，複盤 AI 施工過程
4. **施工錄影（timelapse）**：把一輪多代理編修的展開/摺疊/發光過程錄成可分享影片
5. **熱區/技術債熱圖**：頻繁被改、頻繁出錯的節點以溫度色階標示，指出最該重構的部位
6. **coverage 缺口暗區**：從未被任何測試走過的節點顯示為暗區，讓測試盲點一眼可見
7. **依賴健康**：循環依賴自動偵測與高亮、過度耦合簇警示
8. **效能剖析映射**：profiler 資料驅動節點大小/亮度（慢函式變大變燙）
9. **從視圖直接指揮代理**：點選節點直接對 AI 代理下修改指令，視圖成為調度台
10. **戰情室模式**：投影大螢幕/VR 的展示視角，多代理並行時的全局監控畫面

## 效能與體驗約束

- 函式節點總數 > 2000 時自動降級：預設只顯示檔案層，展開時才載入該檔函式
- 目標 60fps；閃爍動畫走材質 emissive/shader uniform，不得每幀重建幾何或重跑佈局
- 佈局位置要穩定：同一專案重開，節點相對位置大致不變（以固定 seed 或快取座標實現）
- 尊重 `prefers-reduced-motion`：閃爍改為緩慢呼吸式漸變，光流改為靜態高亮
- 色盲友善：紅/綠除顏色外需輔以形狀或圖示差異（如錯誤節點加尖刺/驚嘆標）
- 主題：亮/暗色皆可讀（跟隨 VS Code 主題）

## 工程準則

- 每個 Phase：typecheck ＋ 該階段單元測試全綠才算完成；解析層（tree-sitter 抽取、coverage 映射、狀態機轉移）必須有單元測試
- 零靜默失敗：解析失敗、測試指令跑不起來、掛勾端點錯誤都要在 UI 或 output channel 明確呈現，禁止空 catch
- 狀態機轉移邏輯集中在單一模組，UI 只讀狀態不寫狀態
- 不引入大型框架（前端不用 React/Vue，Webview 內 Three.js ＋ 原生 DOM 即可）

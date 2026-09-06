# 本地驗證與假資料預覽

本文件對應 2026-09-06 本地修補。所有測試使用假資料，沒有連接正式 Auth、Firestore 或寄送郵件。

## 功能測試與建置

在專案根目錄執行：

```powershell
npm test
npm run build
```

目前結果：73 項功能測試通過；Vite 建置成功。主 JavaScript 約 621 kB（gzip 約 181 kB），仍有超過 500 kB 的分包警告，沒有隱藏警告或宣稱已完成載入效能優化。最新行為見 [六項回饋實作](UX_FOLLOWUP_2026-09-06.md)。

## Firestore 權限測試

```powershell
npm run test:rules
```

`scripts/test-rules.mjs` 固定使用 `demo-goodlab-security` 與 `127.0.0.1:8085`，拒絕使用已被占用的連接埠；不呼叫 Firebase CLI、不讀取 `.env`，也不回退至正式服務。測試入口另外檢查環境限制。程式結束會停止自己啟動的模擬器。

目前 17 項測試通過，涵蓋未登入／普通成員／殘留登錄的行政資料存取、維修唯讀、暫停所有學號自行認領與既有身分同步、原子授權與撤權、交易失敗回滾、解除綁定與刪除、管理員學號轉移、值日欄位型別、順延關聯、舊週鎖定與提交完整性、財產匯入與備份重試，以及聘僱單月調整／學期預算清除。被拒絕的測試會輸出 PERMISSION_DENIED；請以測試最終 pass/fail 判斷結果。

需要 Java 21 與 Firestore Emulator JAR。本機已備妥以下忽略版本控制的檔案；換電腦時需另外準備，不能只複製 npm 指令就假定可執行：

- `.local-tools/jdk-21.0.12.1+1-jre/bin/java.exe`：Eclipse Adoptium Windows x64 JRE 21，下載後已依官方 release metadata 核對 SHA-256。Runner 優先使用此可攜版，不修改系統 Java。
- `.local-tools/cloud-firestore-emulator-v1.22.0.jar`：從 Firebase 官方下載位置取得，SHA-256 為 `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`。
- 模擬器記錄寫入 `.local-tools/firestore-test.log`。Runner 固定英文語系，避免目前模擬器缺少 zh_TW 錯誤訊息資源而讓拒絕測試異常。

缺少工具時 runner 會停止；若採系統 Java，請使用 Java 21。不要為了讓測試通過而改成真實 project ID 或移除環境檢查。

## 畫面預覽

```powershell
npm run preview:fixtures
```

開啟 <http://127.0.0.1:8091/>。頂端可切換一般成員／管理員，按「模擬資料更新」可驗證表單草稿是否保留。

盤點預設關閉，可按「開啟盤點（預覽）」切換。聘僱提供兩人、兩計畫的假資料；`/?role=admin&empty=1#/employment` 可檢查無計畫情境。這些開關只變更預覽資料。

此 Vite 設定把 Firebase 模組替換為本地 fixture，停用儲存／登入／登出，且不載入 Excel 函式庫；無法用它驗證真實 Google 登入、Excel 檔案讀取或正式儲存。圖示仍使用既有外部 CDN。一般 `npm run dev` 與 `npm run preview` 並非這個隔離預覽，不應混用。

已手動檢查桌面首頁、375px 手機盤點版面、手機儀器聯絡資訊展開，以及公告／值日留言遇到資料更新後的保留與提示。這不是所有角色、所有頁面的完整端對端驗收。

可用 `/?role=guest` 預覽未開通帳號提示，仍完全使用假資料。

# GOODLAB — GAS 排程寄信設定指南

> GAS 負責週四值日提醒、週一 Admin 週報，以及每 15 分鐘檢查一次的值日完成通知。前端不呼叫公開 GAS Webhook；代班、聘僱與財務等需要強稽核的事件郵件仍留待 Firebase Cloud Functions／notification outbox。架構決策見 [EMAIL_AUTOMATION_DECISION.md](EMAIL_AUTOMATION_DECISION.md)。

## 準備好的檔案

- `gas/Code.gs`：排程、Firestore 讀取、寄信與執行狀態。
- `gas/appsscript.json`：Asia/Taipei 時區與最小必要 OAuth scopes。

這版已包含：

- Firestore 多頁讀取，資料超過單頁不會漏掉。
- 寄信內容 HTML escaping，避免資料欄位破壞信件內容。
- Script Lock，避免同一排程同時重複執行。
- 每次成功／失敗時間寫入 Script Properties。
- `MailApp.getRemainingDailyQuota()` 配額檢查。
- 自動安裝、更新與移除 GOODLAB 管理的觸發器。
- 不含 `doGet()`、`doPost()` 或公開 Web App。

## 1. 使用指定 Google 帳號建立專案

先切換到你準備長期用來寄信的 Google 帳號，再開啟 [script.google.com](https://script.google.com/) 建立獨立專案，命名為「GOODLAB 自動寄信」。

請特別確認右上角頭像不是目前的 YP 帳號。時間觸發器會屬於「建立觸發器的帳號」，也會以該帳號的 MailApp 配額與寄件身分執行。

## 2. 確認 GAS 帳號具備 Firestore 權限

如果建立 GAS 的 `goodlab301@gmail.com` 已經是 GOODLAB Firebase 專案的 Owner，這一步直接跳過，不需要再重複新增 `Cloud Datastore Viewer`。

只有在 GAS 使用另一個、不是 Firebase 專案成員的自動化帳號時，才於 Google Cloud／Firebase IAM 加入：

- 建議角色：`Cloud Datastore Viewer`（`roles/datastore.viewer`）
- 不需要 Editor、Owner 或 Firestore 寫入權限

GAS 使用 Google OAuth token 呼叫 Firestore REST API；這類請求由 IAM 判斷權限，不走前端 Firebase Security Rules。本專案的程式只送出 Firestore GET 請求；若 GAS 帳號同時也是 Firebase Owner，請務必啟用兩步驟驗證並限制帳號分享。

## 3. 貼入 Code.gs

1. 開啟本專案的 `gas/Code.gs`。
2. 全選並複製內容。
3. 回到 Apps Script 編輯器，清空預設 `Code.gs` 後貼上並儲存。

## 4. 貼入 appsscript.json

1. Apps Script 左側「專案設定」。
2. 開啟「在編輯器中顯示 appsscript.json 資訊清單檔案」。
3. 回到「編輯器」，開啟 `appsscript.json`。
4. 用本專案 `gas/appsscript.json` 的內容完整取代並儲存。

必要 scope 包含：

- Firestore 唯讀請求使用的 `datastore`
- `UrlFetchApp`
- `MailApp`
- 安裝／移除觸發器
- 取得測試信收件帳號

## 5. 設定 Script Properties

Apps Script「專案設定」→「指令碼屬性」新增：

| 屬性 | 必填 | 值 |
|---|---|---|
| `FIREBASE_PROJECT_ID` | 是 | Firebase Console「專案設定」內的專案 ID，不是顯示名稱 |
| `GOODLAB_SITE_URL` | 否 | 正式 GOODLAB 網址；設定後信內會顯示開啟系統按鈕 |

設定值不必寫進 `Code.gs`，也不要把帳號密碼或 NTU 帳務系統密碼放進 Script Properties。

## 6. 第一次授權與測試

1. 函式下拉選單選 `testSendToMe`。
2. 按「執行」。
3. 在 Google 授權畫面確認目前是指定 GAS 帳號。
4. 顆粒式權限畫面若可逐項選擇，需同意這個專案列出的必要權限。
5. 查看下方執行紀錄，並確認指定帳號收到「GAS 連線與寄信成功」。

測試信會列出 members、logs、routines 的實際筆數。請與網站資料大致核對；如果筆數明顯太少，先不要裝觸發器。

如要查看正式值日提醒的內容與排版，可再執行 `testDutyReminderToMe`。它會套用本週值日生資料，但只把預覽信寄給目前執行 GAS 的帳號，不會寄給真正的值日生。

如要查看提交完成後寄給全體在學成員的摘要，可執行 `testDutyCompletionToMe`。預覽同樣只寄給目前 GAS 帳號，且不會寫入正式通知的防重寄標記。

## 7. 安裝正式排程

測試成功後，手動執行一次 `installTriggers`。它會先移除本專案既有的同名觸發器，再建立：

| 函式 | 排程 | 收件者 |
|---|---|---|
| `checkDutyReminder` | 每週四 22:00–23:00 | 當週未提交的值日生；若上週未完成則提醒順延後的同一人 |
| `checkDutyCompletionNotification` | 每 15 分鐘 | Active 且 Degree 為 Master／PhD／Bachelor 類型的在學成員（BCC） |
| `checkWeeklyAdminReport` | 每週一 08:00–09:00 | Firestore 中所有 Active Admin |

Apps Script 的每週觸發器會在指定小時內選擇一個時間執行，不保證整點寄出。若當週 duty document 尚未建立，提醒程式會從上一筆未提交紀錄推算順延者，因此不會因尚未開啟網站而漏信。值日完成通知不是由瀏覽器直接寄送；GAS 會輪詢本週與上週已提交紀錄，並以 Script Properties 的週次鍵避免重複寄送。

## 8. 驗收

先手動執行不會寄給其他成員的：

1. `testSendToMe`
2. `testDutyReminderToMe`
3. `testDutyCompletionToMe`
4. `showAutomationStatus`

`checkDutyReminder` 會寄給尚未提交的當週值日生（含上週未完成的順延者），`checkDutyCompletionNotification` 會把尚未通知的完成摘要寄給全體在學成員，`checkWeeklyAdminReport` 會寄給所有 Active Admin，並標示上週是否已順延；只有在確認要送出正式信件時才手動執行，否則交由排程首次觸發。

`showAutomationStatus` 的執行紀錄應顯示：

- `projectConfigured: true`
- `remainingDailyQuota` 大於 0
- 三個 trigger handler
- 對應工作的 `lastSuccess...` 時間
- `lastError...` 為 null 或不存在

如果目前本週值日已完成，`checkDutyReminder` 不寄信是正常結果，執行紀錄會寫明原因。

## 9. 維運方式

- 更新程式後若新增 OAuth scope，必須在編輯器中手動執行一次函式重新授權；背景觸發器不會自行跳出授權畫面。
- 更換 GAS 維護帳號時，舊帳號先執行 `removeManagedTriggers`，新帳號再建立專案、授權並執行 `installTriggers`。
- 每月或異常時執行 `showAutomationStatus` 查看配額、上次成功與錯誤。
- 不要部署成 Web App；這個專案不需要部署網址。

## 常見錯誤

### HTTP 403

GAS 帳號不是 GOODLAB Firebase 專案成員、沒有 `Cloud Datastore Viewer` 以上權限，或 `FIREBASE_PROJECT_ID` 設成錯誤專案。

### HTTP 401／insufficient authentication scopes

`appsscript.json` 沒有完整貼入，或更新 manifest 後尚未重新執行 `testSendToMe` 完成授權。

### 找不到 Active Admin Email

請在 GOODLAB 人員資料確認至少一位成員同時符合：

- `Role = Admin`
- `Status = Active`
- `Email` 格式有效

### 測試成功但排程沒寄

在 Apps Script 左側檢查「觸發條件」與「執行項目」，再執行 `showAutomationStatus` 查看 `LAST_ERROR_*`。

### 重複收到信

重新執行 `installTriggers`；它會清除本專案中同名觸發器後只建立一組。

## 安全界線

- GAS 程式只讀取 Firestore；若使用獨立自動化帳號，IAM 僅授予 Firestore 唯讀權限。
- 若使用同時管理 Firebase 的 GOODLAB Owner 帳號，必須啟用兩步驟驗證並避免共用登入密碼。
- 收件人只從 Firestore members 推導。
- 前端不能指定收件者、主旨或 HTML。
- 不保存 Google、Firebase、NTU 帳務系統密碼。
- 值日完成通知採 GAS 唯讀輪詢與週次防重寄；代班、財務與聘僱等事件型郵件仍留待 Firebase 後端 outbox。

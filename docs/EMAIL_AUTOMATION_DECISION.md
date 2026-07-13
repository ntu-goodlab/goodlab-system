# ADR-001：GOODLAB 自動寄信架構

**狀態：** 已核准，分階段導入  
**日期：** 2026-07-12  
**決策範圍：** 週報、值日提醒、值日交接、代班通知、Routine 到期通知

## 決策摘要

GOODLAB 採用「GAS 排程 + Firebase 事件」的混合方案：

- 固定時間、低頻率、非交易關鍵郵件繼續由 Google Apps Script 執行；值日完成交接短期採每 15 分鐘唯讀輪詢與週次冪等鍵。
- 使用者操作後必須即時寄出、涉及敏感資料或需要完整 delivery 稽核的事件郵件改由 Firebase Cloud Functions 2nd gen 執行。
- 前端不得直接呼叫可由匿名使用者存取、且可自訂收件者與 HTML 的 GAS Web App。
- Cloud Functions 事件信必須有 outbox／delivery 紀錄、冪等鍵、狀態、錯誤訊息與重試資訊；短期 GAS 值日完成通知至少保留週次冪等鍵與執行錯誤紀錄。

## 為什麼排程郵件保留 GAS

- GOODLAB 寄送量小，MailApp 配額足夠。
- 使用實驗室 Google Workspace 帳號寄信，寄件者與管理方式直覺。
- 時間驅動觸發器適合每週一週報與每週四值日提醒。
- 維護成本低，不必為兩個低頻 cron job 立即增加後端部署面。

## 為什麼事件郵件改用 Cloud Functions

目前舊方案由瀏覽器使用 `no-cors` 呼叫 GAS Webhook，存在以下問題：

1. 前端無法讀取成功或失敗回應，畫面只能假設已寄送。
2. Web App 若開放「所有人」，URL 外洩後可能被濫用。
3. 呼叫者可傳入收件者、主旨與 HTML，責任邊界過寬。
4. 使用者關閉頁面、網路中斷或瀏覽器限制都可能造成漏信。
5. 沒有可查詢的寄送狀態、冪等與重試紀錄。

Cloud Functions 可在 Firestore 寫入成功後由事件觸發，使用 Admin SDK 讀取必要資料，並把寄送結果寫回資料庫。Firestore 事件可能重複交付，因此實作必須以 event ID 或業務鍵建立冪等保護。

## 長期目標資料流

```text
使用者提交值日／代班
        ↓
Firestore transaction 寫入業務資料
        ↓
Cloud Function 驗證狀態轉換與收件人
        ↓
建立 notification_outbox/{id}
        ↓
郵件供應器寄送
        ↓
delivery.status = sent | retrying | failed
```

## 郵件責任分配

| 郵件 | 執行平台 | 原因 |
|---|---|---|
| 每週 Admin 報表 | GAS | 固定排程、低量、容許小時區間內執行 |
| 值日未完成提醒 | GAS | 固定排程、低量；當週文件尚未建立時可唯讀推算上一週的順延者 |
| Routine 到期摘要 | GAS（短期） | 可併入排程摘要 |
| 值日完成交接 | GAS 輪詢（短期）／Cloud Functions（長期） | 現階段容許最長約 15 分鐘延遲，GAS 以週次鍵防重寄；未來若需完整 delivery 稽核再遷移 |
| 代班邀請／接受／拒絕 | Cloud Functions | 事件型、需驗證操作者與避免重複寄送 |
| 財務或聘僱通知 | Cloud Functions | 敏感、需稽核與後端權限 |

## 郵件傳輸選項

首選順序：

1. Firebase Cloud Functions + Google Workspace／受控 SMTP 或郵件 API。
2. Firebase 官方 Trigger Email extension，適合希望降低寄信程式碼量時使用；需要 Blaze 方案與 SMTP/OAuth 設定。
3. GAS 僅保留排程，不再作公開事件 Webhook。

## 導入階段

### Stage A — 立即

- `GAS_WEBHOOK_URL` 保持空值。
- GAS 建立週一、週四及每 15 分鐘的值日完成檢查觸發器。
- 修正 GAS 報表欄位與目前 Firestore schema 的差異。
- 使用實驗室共用／可交接的 Workspace 帳號建立觸發器。

### Stage B — Firebase 後端

- 建立 `functions/`、Firebase Emulator 與部署設定。
- 建立 `notification_outbox`、模板與 delivery status schema。
- 視稽核需求將值日完成通知遷移至 outbox，並實作代班事件函式。
- 函式需冪等、具結構化 log，並限制收件者只能來自有效 members。

### Stage C — 維運

- Admin 介面可查看最近寄送狀態與重試結果。
- 對 outbox/delivery 文件設定保存期限或 TTL。
- 建立第二位維護者與帳號交接 SOP。

## 驗收條件

- 前端不包含可公開濫用的寄信 Webhook。
- 同一業務事件重送不會產生重複郵件。
- 失敗郵件可被查詢並重試。
- 郵件收件者由後端資料推導，不接受前端任意指定。
- GAS 配額可透過 `MailApp.getRemainingDailyQuota()` 監控。
- 所有排程使用 `Asia/Taipei` 時區並記錄最後成功時間。

## 官方參考

- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
- Apps Script installable triggers: https://developers.google.com/apps-script/guides/triggers/installable
- Firebase scheduled functions: https://firebase.google.com/docs/functions/schedule-functions
- Firestore events: https://firebase.google.com/docs/functions/firestore-events
- Firebase Trigger Email extension: https://extensions.dev/extensions/firebase/firestore-send-email

# GOODLAB 實驗室管理系統

GOODLAB 是以 Vite、Vanilla JavaScript、Firebase Authentication 與 Cloud Firestore 建立的實驗室營運管理系統。

## 目前版本

- 升級計劃：v5.0 Scientific Operations Edition
- 狀態：Phase 1 執行中
- 部署：GitHub Pages
- 角色：Guest、User、Admin

## 本機開發

```bash
npm install
npm run dev
npm run build
```

環境變數請參考 `.env.production` 的欄位名稱，在本機 `.env` 提供對應的 Firebase Web 設定。Firebase Web API key 不是授權機制；資料安全必須由 Firestore Security Rules、網域限制與後端驗證負責。

## 架構

- `index.html`：App shell、頁面與靜態 Modal 結構
- `style.css`：全站 tokens、元件與 responsive styles
- `src/app.js`：主協調器、路由、角色化即時監聽
- `src/auth.js`：Google 登入、綁定、Guest/User/Admin 權限
- `src/*.js`：人員、儀器、維修、帳務、產編、值日、Routine、聘僱模組
- `design-system/goodlab/MASTER.md`：v5 Design System 唯一真相來源
- `gas/Code.gs`、`gas/appsscript.json`：GAS 排程寄信程式與權限設定
- `docs/EMAIL_AUTOMATION_DECISION.md`：GAS 與 Firebase 郵件架構決策

## v5 資料載入原則

1. 先取得 Firebase Auth 狀態。
2. 已登入使用者只先讀取 members，以確認綁定與角色。
3. User 只訂閱 members、instruments、logs、inventory、duty_records。
4. Admin 才額外訂閱 accounting、routines、projects、employments。
5. 登出或角色改變時解除不再需要的 subscriptions。

## 自動寄信

- 值日輪值：未提交時由同一位值日生承接新週清單，完成後才前進下一位；Admin 手動指定可明確覆寫順延。
- GAS：每週 Admin 報表、可推算順延者的值日未完成提醒、Routine 排程摘要，以及具週次防重寄的值日完成通知。
- Firebase Cloud Functions（規劃中）：代班、財務與聘僱等需要強稽核的事件通知。
- 舊 `GAS_WEBHOOK_URL` 與 `no-cors` 呼叫已移除；前端不得直接呼叫公開寄信 Webhook。

## 相關文件

- 根目錄 `GOODLAB 實驗室管理系統計劃書v5.md/.docx`
- `docs/GAS_SETUP_GUIDE.md`
- `docs/FIREBASE_RULES.md`
- `docs/EMAIL_AUTOMATION_DECISION.md`

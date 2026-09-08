# GOODLAB — Firestore 規則與發布狀態

> 發布更新：使用者已授權新版上線，部署設定與 Pages build 已改為核准成員模式。以下為切換前紀錄；目前方案與驗證、回復步驟以 [新版發布紀錄](APPROVED_ACCESS_RELEASE.md) 為準。正式完成狀態須查看發布收據。

## 目前正式環境

2026-09-09 已將 `logs` 恢復 Admin-only，並讀回核對原始 ruleset。正式狀態及恢复證據見 [維修紀錄權限紀錄](MEMBER_RECORD_ACCESS.md)。這次全面重寫沒有再修改線上權限。

`firebase.json` 與 `firebase.production.json` 都指向 `rules/production.firestore.rules`。根目錄 `firestore.rules` 是先前尚未完成迁移的候選版，已退出預設部署設定，保留作既有回歸測試。它仍包含登入者可讀資料的舊設計，不能手動貼到正式環境。

## 新的完整候選版

新版已完成本機網站整合，透過 `VITE_ACCESS_MODEL=approved` 啟用；現有預設模式與線上權限尚未切換。最新進度與既有綁定帳號遷移方式見 [整合紀錄](APPROVED_ACCESS_INTEGRATION.md)。

使用者已選擇「管理員核對 Google 帳號後開通」。完整規則、權限矩陣、交易 helper 與上線前整合要求見 [管理員核准成員版](APPROVED_MEMBERSHIP_RULES.md)。

- 規則：`rules/member-approved.firestore.rules`
- 核准、升降權、撤權 helper：`src/approved-member-access.js`
- 真正 Firestore emulator 請求測試：`tests/member-approved.rules.mjs`
- 新版測試指令：`npm run test:rules:approved`
- 既有規則回歸測試：`npm run test:rules`

新版用管理員核准的 UID 對應驗證成員資格。Guest 只能存取自己的申請／授權狀態，不能讀實驗室資料；核准成員可讀維修、儀器、盤點及值日，行政集合僅 Admin。完整成員資料與最小名錄分開。

## 發布前提

新版已接上登入、管理介面、名錄查詢及管理員確認值日排班；尚未為正式既有帳號建立已核准 UID 對應。不可僅因本機測試通過就直接部署，否則合法管理員及成員可能被拒絕。

必須先完成新版文件中的既有帳號核對、至少一位管理員的可信任初始化、前端整合、值日指派及假資料整合驗收，再備份當時線上規則與遷移資料，取得正式發布確認。Google UID、信箱、角色或目前線上版本不一致時應停止核對，不能改回登入即可讀寫。

目前 GitHub Pages 的網站部署不會發布 Firestore Rules。現有 GitHub 驗證流程已加入新版權限測試，但未在本機宣稱雲端 CI 已通過。

## 規則版本辨識

| 檔案 | 用途 | 是否部署來源 |
|---|---|---|
| `rules/production.firestore.rules` | 與最近核對的正式環境相符，logs Admin-only | 是 |
| `rules/member-approved.firestore.rules` | 本次完整重寫，待資料與網站整合 | 否 |
| `firestore.rules` | 舊的待遷移候選版，僅保留回歸驗證 | 否 |

官方文件：[條件與原子交易](https://firebase.google.com/docs/firestore/security/rules-conditions)、[查詢授權](https://firebase.google.com/docs/firestore/security/rules-query)、[欄位存取](https://firebase.google.com/docs/firestore/security/rules-fields) 。

# 一般成員紀錄讀取修正

## 已確認原因

2026-09-07 透過 Firebase CLI 授權讀取 `goodlab-system` 的正式規則，原 ruleset 為 `476a4e21-7877-42b7-8db0-071f7a9e770e`。

- `logs` 原本把 read/create/update/delete 一起限制為 Admin，造成一般成員整個列表讀取被拒絕。
- `duty_records` 原本已允許登入者讀取。前端「執行紀錄」按鈕放在本週清單內，等待順延、輪值不符或無當週人員的提前返回分支都不會顯示入口。

## 修正範圍

`rules/production.firestore.rules` 以取回的正式規則為基底，只拆開 logs 的 read 與寫入授權。read 使用與現有值日、儀器相同的 `isSignedIn()`；create/update/delete 維持 `isAdmin()`。這個既有讀取界線是 Firebase 登入者，並非新的名冊綁定驗證機制。

保留正式環境原本以 UID 登錄存在與否判斷 Admin 的方式，以及全部其他集合與寫入規則。根目錄 `firestore.rules` 仍是尚未完成遷移的候選版本，不能用來部署本次修補。

值日頁的執行紀錄改成位於動態清單外的固定連結。本週輪值等待處理時，仍可查看歷史紀錄。

## 發布與回復

正式規則使用獨立設定：`firebase deploy --project goodlab-system --config firebase.production.json --only firestore:rules`。發布前必須核對線上 ruleset 仍為本次基底；若已有其他更新，先重新比對。原始規則及 release 資訊另保存在未加入 Git 的 `.local-tools/live-rules-before.json`。

網站仍透過 GitHub Pages 發布；Pages 不會部署 Firebase 規則。必要時可將 Firestore release 指回上方舊 ruleset 回復權限修補。

## 驗證

模擬器同時驗證候選規則與本次正式規則：一般成員可查詢完整 logs/duty_records 列表、未登入者拒絕、成員無法新增／修改／刪除維修紀錄或修改他人值日、舊格式 Admin 維持管理權限。測試僅使用本機假資料。

正式發布後需重新讀取目前生效 ruleset 與檔案內容比對；本機模擬器的成功不代表已使用正式一般成員的登入狀態驗收。

本次已發布並回讀核對的 ruleset：`923ff391-04c5-4062-8774-9a1ce15ff272`，內容與正式規則檔一致。76 項功能測試、20 項規則測試及建置通過；假資料頁 `?role=user&dutyState=carryover#/duty` 已確認一般成員可從順延等待畫面開啟歷史紀錄。尚未代替真實一般成員執行登入驗收。

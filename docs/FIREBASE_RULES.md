# GOODLAB — Firestore Security Rules 上線指南

正式規則已集中在專案根目錄的 [`firestore.rules`](../firestore.rules)。請勿再混用 2026-05-23 或早期 Phase 5 的片段規則；舊版 `duty_records` 曾允許所有登入者任意修改，不適合正式上線。

## 這版保護什麼

| 資料 | 一般成員 | Admin |
|---|---|---|
| 成員 | 登入後可讀；可用任一 Google 帳號認領尚未綁定的學號 | 可管理 |
| 儀器 | 可讀 | 可管理 |
| 維修紀錄 | 不可讀寫 | 可完整管理 |
| 產編 | 盤點開放時可更新狀態、區域、細項位置，並留下操作者 | 可完整管理 |
| 值日 | 只有當週值日生可勾選、提交、邀請代班；受邀者只能接受或拒絕 | 可對齊與管理 |
| 公告／行事 | 只讀取已公開資料 | 可管理 |
| 公積金／聘僱 | 不可讀取 | 可完整管理 |

畢業成員若已完成帳號綁定，仍可登入；這版沒有以 `Status` 阻擋登入。

## 發布前準備

1. Firebase Console → Firestore Database → 資料。
2. 確認 `admins/{Google UID}` 文件已存在，且文件 ID 是目前 Admin 的 Firebase Authentication UID。
3. `Email` 是學校通知信箱；登入用 Google 信箱與顯示名稱會另存為 `Google_Email`、`Google_Display_Name`，三者互不替代。
4. 至少保留一個可用 Admin UID，避免發布後把自己鎖在管理功能之外。

## 發布方式

目前網站使用 GitHub Pages，發布網頁不會自動發布 Firestore Rules。請擇一執行：

### Firebase Console（最直接）

1. Firebase Console → Firestore Database → Rules。
2. 用 [`firestore.rules`](../firestore.rules) 的完整內容取代現有規則。
3. 按「發布」。

### Firebase CLI

在已登入正確 Firebase 帳號且選好專案後執行：

```bash
firebase deploy --only firestore:rules
```

專案根目錄的 `firebase.json` 已指向正確規則檔。

## 必做驗收

使用 Firebase Rules Playground 或兩個實際帳號測試：

1. 未登入者讀 `members`：拒絕。
2. 一般成員讀取或新增 `accounting`、`logs`：拒絕。
3. 一般成員修改別人的 `duty_records`：拒絕。
4. 當週值日生勾選自己的清單：允許。
5. 產編關閉時，一般成員修改產編：拒絕；開放後只允許狀態、區域與細項位置。
6. 任一 Google 帳號可認領尚未綁定的學號，並正確寫入 `Google_UID`、`Google_Email` 與 `Google_Display_Name`。
7. 已被其他 Google UID 認領的學號不能再次綁定。
8. Admin 的公告、行事、帳務、聘僱與維修管理：允許。

若 Admin 操作全部被拒絕，先檢查 `admins` 文件 ID，而不是放寬規則。

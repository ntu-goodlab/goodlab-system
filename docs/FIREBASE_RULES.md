# GOODLAB — Firestore Security Rules 上線指南

專案根目錄的 [`firestore.rules`](../firestore.rules) 是本地候選規則，尚未發布。2026-09-06 已通過 13 項本地權限測試，仍有身分綁定、成員欄位可見範圍與週指派風險。先閱讀 [本次修補與未完成事項](REVIEW_IMPLEMENTATION_2026-09-06.md)，保留線上暫時停止自助綁定與新增 admins 的規則；不能僅因本地測試通過就直接覆蓋。

## 這版保護什麼

| 資料 | 一般成員 | Admin |
|---|---|---|
| 成員 | 登入後可讀；已驗證 Google 帳號可認領尚未綁定的 User，不能認領預設 Admin；學號仍不足以證明身分 | 可管理 |
| 儀器 | 可讀 | 可管理 |
| 維修紀錄 | 登入後可讀，不可新增、修改或刪除；目前讀取界線不驗證名冊綁定資格 | 可完整管理 |
| 產編 | 盤點開放時可更新狀態、區域、細項位置，並留下操作者 | 可完整管理 |
| 值日 | 已指派本人且未提交的紀錄可更新；提交需要完整清單。新週建立的輪值歸屬尚未有可信任後端驗證 | 可對齊與管理，提交仍檢查完整性 |
| 公告／行事 | 只讀取已公開資料 | 可管理 |
| 公積金／聘僱 | 不可讀取 | 可完整管理 |

畢業成員若已完成帳號綁定，仍可登入；這版沒有以 `Status` 阻擋登入。

## 發布前準備

1. Firebase Console → Firestore Database → 資料。
2. 確認現有 Admin 的 `admins/{Google UID}.student_id` 對應 member 文件 ID，該文件 `Google_UID` 與 `Role=Admin` 一致。登入不會自行建立管理員登錄；只有既有授權管理員能透過成員交易授權他人。
3. `Email` 是學校通知信箱；登入用 Google 信箱與顯示名稱會另存為 `Google_Email`、`Google_Display_Name`，三者互不替代。
4. 至少保留一個可用 Admin UID，避免發布後把自己鎖在管理功能之外。

## 發布方式

目前網站使用 GitHub Pages，發布網頁不會自動發布 Firestore Rules。下列為未來發布程序，必須先完成未解決風險與管理員資料相容性驗收、取得正式發布授權；本次未執行：

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

先依 [本地驗證](LOCAL_VALIDATION.md) 使用模擬器；正式帳號驗收需另行安排，不應在正式資料庫執行破壞性權限測試：

1. 未登入者讀 `members`：拒絕。
2. 一般成員讀取或新增 `accounting`：拒絕；讀取 `logs` 允許，新增／修改／刪除拒絕。
3. 一般成員修改別人的 `duty_records`：拒絕。
4. 當週值日生勾選自己的清單：允許。
5. 產編關閉時，一般成員修改產編：拒絕；開放後只允許狀態、區域與細項位置。
6. 未驗證 Google 帳號及預設 Admin 認領必須拒絕；普通 User 自助綁定何時恢復，須先解決學號冒名與 UID 唯一對應問題。
7. 已被其他 Google UID 認領的學號不能再次綁定。
8. Admin 的公告、行事、帳務、聘僱與維修管理：允許。

若 Admin 操作被拒絕，先核對登錄、成員文件 ID、UID、角色及目前線上規則。網站不會自動補建白名單，也不應直接發布未驗收的規則來嘗試修復。

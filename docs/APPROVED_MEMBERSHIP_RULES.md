# Firestore 全面重寫：管理員核准成員版

> 後續整合已完成：新版登入、核准介面、成員管理、學號移轉、名錄及管理員確認值日流程已接到獨立 `approved` 模式。最新狀態、測試與仍待正式資料核對的事項見 [整合紀錄](APPROVED_ACCESS_INTEGRATION.md)。下方保留第一版規格；當中的「尚未接上網站」及 25 項測試數字是當時狀態，已由整合紀錄取代。名錄另已明確增加 Role、Enrollment_Date 以維持值日排序。

2026-09-09。本版是完整、獨立的規則候選檔：[`rules/member-approved.firestore.rules`](../rules/member-approved.firestore.rules)。使用者已選擇「管理員核對 Google 帳號後開通」。本次完成規則、核准／撤權交易 helper、本機權限測試與整合規格；未發布規則、未修改正式資料、未部署網站。

**不可直接貼到正式環境。** 目前網站仍以舊 `members` 全表讀取啟動登入、以 `admins` 判定管理員，尚未接上新版流程。新的授權、名錄與排班資料也尚未建立。此候選版通過測試不等於既有網站已具備上線條件。正式 `logs` 保持 Admin-only。

## 授權來源

登入只證明帳號身分；`access_requests` 只是一份待核對的申請。兩者均不授予實驗室資料權限。

每個 UID 只有一份 `member_access/{uid}`，只有已核准管理員能建立／修改。讀取實驗室資料時同時檢查：

1. Firebase token 表示 Google 登入且信箱已驗證。
2. UID 對應存在，token 信箱與核准信箱相同。
3. 對應的 `members/{student_id}` 存在，學號、Google UID、Google 信箱及角色全部一致。
4. 成員 `Status == 'Active'`，角色是 `User` 或 `Admin`。

Admin 還必須具有一致的 `role == 'Admin'`。舊 `admins`、前端角色、學號、單獨的 `members.Role` 都不再是授權來源。資料不一致時拒絕，不以「登入即可」作為備援。離校 `Alumni` 不具有資料權限；Google 信箱更換需由管理員重新核對。

資料範例（假資料）：

```text
member_access/demo-uid
  student_id: demo-student
  email: member@example.test
  role: User
  approved_by: demo-admin-uid
  approved_at: Firestore server timestamp

members/demo-student
  Student_ID: demo-student
  Google_UID: demo-uid
  Google_Email: member@example.test
  Role: User
  Status: Active
  ...現有私有成員欄位
```

`getAfter()` 檢查同筆交易完成後的雙向對應，拒絕一個 UID 同時綁定兩位成員、單邊改角色、移轉 UID 卻未解除旧對應等情況。管理員也不能自行刪除／變更自己的授權；需由另一位管理員處理。服務帳號或 Console 的可信任管理操作不受此 client Rules 邊界保護，須另以 IAM 管理。[Firebase 条件與交易驗證](https://firebase.google.com/docs/firestore/security/rules-conditions)

## 集合權限

| 集合 | Guest／未核准 | 核准成員 | 核准 Admin |
|---|---|---|---|
| `member_access` | 已驗證 Google 帳號只能 get 自己的狀態 | get 自己 | 管理，但不能自行改自己的授權 |
| `access_requests` | 只能提交、get、刪除自己的申請；信箱與名稱取自 token | 有既有對應時不能再申請 | 查看及處理申請 |
| `members` | 不可讀寫 | 只能 get 自己；僅同步 token 顯示名稱 | 管理，授權欄位需原子一致 |
| `member_directory` | 不可讀寫 | 可讀最小名錄 | 寫入只接受指定欄位並核對原資料 |
| `logs`、`instruments` | 不可讀寫 | 可讀 | 完整管理 |
| `inventory` | 不可讀寫 | 可讀；開放盤點時只改狀態、位置、備註與本人操作欄位 | 完整管理 |
| `duty_assignments` | 不可讀寫 | 可讀 | 建立可信任的每週指派 |
| `duty_records` | 不可讀寫 | 可讀；有核准指派才可建立自己的週紀錄，只能更新自己未提交的紀錄 | 可管理，提交仍須完整清單 |
| `bulletins`、`routines` | 即使已公開也不可讀 | 只讀 published／visible_to_users 為 true 的文件 | 管理全部 |
| `accounting`、`projects`、`employments`、`inventory_archive` | 不可讀寫 | 不可讀寫 | 完整管理 |
| 舊 `admins` | 不可讀寫 | 不可讀寫 | 只供讀取舊資料；不授權、不再寫入 |
| 未宣告集合與子集合 | 拒絕 | 拒絕 | 拒絕 |

共用名錄只包括 `Student_ID`、`Name_Ch`、`Name_En`、`Degree`、`Status`。Google UID／信箱、電話、身分歷史及未來新增欄位不會透過名錄暴露。Firestore 無法僅隱藏文件內某些欄位來限制讀取，故使用獨立投影集合。[Firebase 欄位存取說明](https://firebase.google.com/docs/firestore/security/rules-fields)

核准成員仍能讀完整維修紀錄；這是原需求的資料範圍，並非所有登入者可讀。儀器與盤點文件亦維持核准成員完整可讀。這版沒有做敏感內容自動辨識或個別紀錄刪節。

## 新成員及管理操作

[`src/approved-member-access.js`](../src/approved-member-access.js) 提供已在模擬器驗證的交易 helper，**目前未匯入正式網站流程**：

- `requestApprovedMembership`：本人提交學號主張及 token 對應的信箱、名稱。Guest 不讀名冊，也不自行寫 UID 或角色。
- `approveMembershipRequest`：管理員核對本人與 Google 帳號後，傳入看過的 UID、學號及 expectedEmail。交易重讀申請；資料變更則要求重新核對。首次核准固定為 User，同時更新成員、UID 對應、最小名錄及刪除申請。
- `saveApprovedMember`：一般資料編輯同步最小名錄；升降權原子更新角色。不能藉普通儲存默默核准舊綁定或更換 Google UID。
- `revokeApprovedMembership`：解除綁定時移除 UID 對應、降回 User，保存私有歷史；刪除成員時一併刪除 UID 對應及名錄。撤權後原 token 也不再通過後續資料請求。

Rules 不會辨識現實中的實驗室成員，也不能保證管理員每次都核對正確。管理員應向本人核對申請，不可只憑填入的學號自動通過。非信任用戶提交的 display name 不可當作真實姓名證明。

## 上線前必須完成的整合

目前規則重寫完成；以下屬需要協調資料與網站的上線整合，未執行：

1. **既有資料唯讀盤點與人工核准。** 比對 Firebase Auth 的 UID、已驗證 Google 信箱、是否停用，及成員學號、Role、Status、重複 UID、缺失欄位。不得把所有舊 `Google_UID` 自動當作已核准。先列出明確核准的遷移清單供管理員確認。
2. **初始管理員。** 至少一位、建議兩位已核對的現有管理員需先由可信任的管理端建立合法 `member_access` 與一致成員資料。舊規則拒絕新集合的 client 寫入，故需另外授權的管理端遷移；不能在新版增加「任何登入者可建立第一位 Admin」的後門。
3. **登入與即時監聽。** `src/auth.js` 改成先監聽本人的 `member_access`，通過後讀本人的 `members` 文件，再決定 User／Admin。`src/app.js` 的 Guest 訂閱必須改為空集合；User 使用 `member_directory`，Admin 才使用 `members`。取消 legacy admins 查核；處理撤權、切換帳號、過期回呼、權限錯誤及快取清除。不能以舊名錄或單純 Google 登入暫時放行。
4. **核准介面。** Guest 可送出自己的申請；Admin 在成員頁核對申請後呼叫新版 helper。完整接上儲存、升降權、解除、刪除、學號移轉。舊 helper 仍寫 `admins`，不能直接沿用。本人變更學號需由另一位管理員操作。移轉須原子更新 UID 對應、新舊成員及最小名錄，並保留既有業務紀錄移轉。
5. **每週指派。** 由已核准管理員或可信任排程建立 `duty_assignments/{weekId}`；`src/duty.js` 不再自行推測權威指派。代班、順延的新週同樣先取得核准指派。尚未接上前，新規則會擋住目前成員自行建立新週的流程。日期格式檢查不等於日曆／當週驗證；週次由核准指派決定。
6. **查詢及版面。** 公告／行事沿用 `where('published', '==', true)`／`where('visible_to_users', '==', true)`；完整集合查詢會被拒絕，規則不會替查詢過濾資料。成員名錄畫面與值日排序所需額外欄位需逐一評估，再明確加入投影，不可整份複製 members。[Firebase 查詢規則](https://firebase.google.com/docs/firestore/security/rules-query)
7. **假資料整合與部署協調。** 用新舊帳號、撤權、離校、管理員遷移、名錄、值日新週與學號移轉完成整合測試。備份生效 ruleset 及遷移資料，安排網站與規則的切換順序，再呈交完整變更供正式發布確認。回復規則也需要對應的前端版本；不可只把規則切回而留下新舊授權模型混用。

## 驗證與部署防誤用

```powershell
npm run test:rules:approved
npm run test:rules
npm test
```

新版測試在 `demo-goodlab-security`、`127.0.0.1:8085` 執行，缺少本機工具或連接埠被占用時停止，不回退正式服務。25 項測試包含真正的 get、list、create、update、delete、原子核准／升降權／撤權、錯配與重複 UID、私有欄位、可見性查詢、盤點及值日操作。新規則的測試已加入既有 GitHub 驗證流程；未執行雲端 CI。

本次結果：新版 25 項權限測試、既有 20 項權限回歸測試、76 項功能測試全部通過；`git diff --check` 通過。初次測試發現值日寫入重複呼叫完整身分查核而超過運算上限，已改成先驗證一次成員，再查角色與指派，重新測試通過。未執行正式使用者登入驗收，也未修改目前網站的登入程式。

`firebase.json` 與 `firebase.production.json` 現在都指向 `rules/production.firestore.rules`，也就是已恢復 `logs` Admin-only 的正式規則。根目錄 `firestore.rules` 是先前待遷移版本，保留做既有回歸測試，不是部署來源；此新版同樣未被任何部署設定引用。切换部署來源是整合驗收完成後的明確發布步驟。

這些規則限制的是 Firebase client 請求；不能撤回已下載的資料、確認過去是否外洩，或保證 Codex 對話不再出現暫停提示。

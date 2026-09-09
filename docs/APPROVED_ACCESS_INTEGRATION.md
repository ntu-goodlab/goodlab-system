# 新版授權整合與既有帳號遷移

> 後續更新：已開始正式發布核對，部署設定與 CI build 已接上新版。下文保留整合階段紀錄；發布階段的資料核對、驗證與回復步驟見 [新版發布紀錄](APPROVED_ACCESS_RELEASE.md)。

2026-09-09。本次為本機整合，未連線查詢正式成員或 Auth 名冊、未遷移正式資料、未發布規則或網站。

## 既有 Google 帳號是否需要重新申請

不必全部重新申請。管理員先做一次遷移核對：UID 唯一、Auth 帳號存在且未停用、Google 信箱已驗證、帳號與成員資料一致、成員為 Active。符合條件的帳號列為待確認清單，管理員確認後直接建立新版 UID 授權，成員沿用原本的 Google 登入。

重複 UID、信箱衝突、Auth 帳號不存在／停用、未驗證或離校者不自動開通。歷史資料缺 Google_Email 時，可從已驗證的 Auth 資料提出補齊值，仍需管理員確認。規則及程式都沒有「已有 Google_UID 就視作核准」的備援。

唯讀離線核對工具：

```powershell
node scripts/plan-approved-migration.mjs INPUT.json NEW-REPORT.json
```

輸入為 `{ members: [...], authUsers: [...], approvedUids: [...] }`。`authUsers` 使用 Firebase Auth 管理端匯出的 uid、email、emailVerified、disabled、providerData 欄位。首次核對 `approvedUids` 留空；核對後只填入已明確確認的 UID。工具不含網路或部署操作、拒絕覆寫報告，只產生評估結果；`readyForMigration` 不是正式發布許可。正式資料匯出與套用遷移尚未執行。

## 已接上的網站流程

- `VITE_ACCESS_MODEL=approved` 明確啟用新版；未設定則保持原流程。新版失敗時不回退 legacy 權限。`src/access-mode.js` 是唯一模式選擇點。
- 登入先查自己的 `member_access/{uid}`，再查自己的 `members/{student_id}`。只有伺服器確認且雙向資料一致時才啟用 User／Admin。切換帳號、撤權、資料錯配與延遲回呼均有處理；停用的集合監聽不會重新灌入舊帳號資料。
- Guest 只能看到自己的授權／申請狀態及學號申請表，不訂閱 members 全表。
- Admin 成員頁新增待核准清單及確認對話框。學號與 Google 信箱需向本人核對；申請在交易中重讀，首次開通固定 User。
- 成員儲存、升降權、解除綁定、刪除走新版原子 helper，維護 UID 對應與名錄。學號移轉同步舊新 member、UID 對應、名錄與業務引用；旧未核准綁定不能透過轉移變相取得授權。
- User 的成員頁改讀 `member_directory`；只分享姓名、學号、學位、在學狀態、角色及入學日期。角色與入學日期用於排除管理員及維持既有值日順序。Google UID／信箱、電話、歷史綁定等仍不在名錄中；系所未開放，畫面也不誤標成「未填系所」。
- 公告／行事繼續使用可見性查詢；維修列表只有核准成員可讀。
- 值日以管理員已核准的紀錄／指派為準。Admin 可確認本週、指定下週、核對後順延上週；指派及清單原子建立。成員只能初始化自己的已核准指派、編輯本人未提交工作。新週未核准時顯示等待提示，不在瀏覽頁面時自行推算並寫入正式排班。

目前沒有部署自動排班後端。管理員須確認新週或提前指定下週；若日後要恢復全自動排班，應由可信任的排程產生同樣的指派文件。已保留舊格式歷史資料唯讀，Admin 可在學號移轉時只更新引用，不必重寫歷史清單；舊格式可編輯的在途值日紀錄仍需在正式遷移時逐筆檢查其欄位完整性。

## 本機預覽

```powershell
npm run preview:approved
```

開啟 `http://127.0.0.1:8092/`。上方可切換一般成員、未開通帳號、管理員。核准、申請及儲存只改頁面記憶體中的假資料，重新載入即重置。這份预覽不是安全規則模擬器；真正的拒絕／允許測試在下列 Firestore emulator 測試中執行。

已在 Browser 檢查 Guest 申請更新、Admin 核對確認與核准成功、User 名錄顯示。確認核准後待辦消失，無頁面 console error。原生 confirm 在瀏覽器控制時卡住，因此新核准流程改用頁內對話框；不涉及原先 Codex 暫停監控的修復。

## 測試

```powershell
npm test
npm run test:rules:approved
npm run test:rules
npm run build
```

功能測試涵蓋遷移候選／明確確認、重複與失效帳號、未驗證帳號、UID 對應監聽順序、伺服器／快取區別、升降權及過期回呼。

本輪結果：83 項功能測試、31 項新版 Firestore 模擬器測試通過。新版與原模式建置通過；雲端 CI 尚未執行。

新版模擬器測試另涵蓋沿用舊 Google 帳號不需新申請、實際學號移轉 helper、阻擋未核准舊綁定、實際核准排班／初始化／順延 helper、歷史學號引用更新等。所有規則測試固定使用 `demo-goodlab-security` 與 localhost，不回落正式環境。

兩種 build 均已在本機驗證；新版 build 可使用 `$env:VITE_ACCESS_MODEL='approved'` 後執行 `npm run build -- --outDir .local-tools/approved-build`。一般 build 仍保留原模式。Vite 仍提示主檔超過 500 kB，未處理分包效能。

## 正式切換前仍需要的確認

1. 授權唯讀匯出與比對正式成員、Auth 帳號及在途值日格式，提交管理員核對清單。
2. 備份規則與待遷移文件，明確核准待遷移 UID；至少一位既有管理員需先由可信任管理端建立合法新版授權，建議保留兩位管理員。不能讓 client 自行建立第一個 Admin。
3. 按已確認清單建立 UID 對應與最小名錄，補齊必要的 Google 信箱與在途值日欄位，整理已核准排班。此處沒有自動執行正式遷移的程式。
4. 共同確認前端新版 build、規則切換及回復順序。發布後讀回規則並用已核准真實帳號驗收；未核准者應留在申請頁。

目前兩份 Firebase 部署設定仍指向 `rules/production.firestore.rules`，正式 `logs` 維持 Admin-only。新版規則與網站模式須在上述步驟完成後一起切換，不能只貼規則或只發布新版網站。

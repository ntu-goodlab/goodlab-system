# 核准成員授權版本：發布與回復

2026-09-09：使用者已授權發布。此文件說明發布方案；完成時間與正式驗證結果以實際發布收據為準。

## 發布內容

GitHub Pages 的 build 明確設定 `VITE_ACCESS_MODEL=approved`，CI 也建置同一模式。三份 Firebase 設定都指向 `rules/member-approved.firestore.rules`，避免一般部署意外重新發布舊的寬鬆規則。`rules/production.firestore.rules` 保留為本次切換前、維修紀錄 Admin-only 的回復參考及舊版回歸測試來源；不再是預設發布來源。

核准的有效成員可讀維修紀錄；Admin 可管理公積金、維修等資料。Google 登入本身不能取得成員權限。升降權在交易中同步 `members` 與 `member_access`，不再需要另建舊 `admins` 文件。

## 正式資料核對與遷移

唯讀核對結果：36 筆成員、12 個既有綁定，11 個符合有效 Google 帳號與 Active 成員条件；另 1 個已離校綁定不開通，未綁定者留在管理員核准流程。沒有重複 UID。兩筆缺少的 Google 信箱由已驗證的 Auth 帳號補齊。角色與舊管理員登錄不一致的名單另由使用者確認，不將個人名單、UID 或信箱提交 Git。

本機 `.local-tools/approved-release-audit.json` 保存切換前相關文件、最小 Auth 核對資料與原規則。遷移清單另存 `approved-release-plan.json`。以單次原子 commit 套用，對既有文件使用 updateTime、對新文件使用 exists=false 前置條件；執行前再次檢查相關集合與 Auth 狀態，異動則停止重新核對。

保留全部原成員資料與歷史值日紀錄。建立最小成員名錄與已确认帳號授權。本週值日僅把舊 `assignment_source: admin` 轉為 `manual`，建立對應指派；不覆寫清掃、補給、備註、完成狀態或負責人。尚未部署自動排班後端，管理員須確認新週或提前指定下週。

## 驗證與順序

1. 功能測試 83 項、新版規則測試 31 項與 approved build 通過。
2. 在只連 localhost 的 demo emulator 中套用實際候選遷移，驗證每個核准身分、公積金角色限制、Guest／離校拒絕，以及本週值日進度保留與編輯。模擬身分不等於真實帳號登入驗收。
3. 名單確認後先遷移資料並讀回驗證；舊規則尚不開放新增授權集合。
4. GitHub PR 驗證通過後合併並等待 Pages 成功，核對公開網站產物與本機 approved build 一致。
5. 切換 Firestore 規則並讀回全文核對。切換時可能短暫顯示授權尚未就緒；開著舊網頁的使用者需要重新整理。
6. 正式匿名請求應被拒絕；核准帳號的真實登入驗收需有該帳號登入工作階段，不能用管理端 IAM 請求冒充使用者驗證。

## 回復

切換前網站 main 為 `22b213b44b28ee2be41f80d59d5aa0f147f3e07a`；規則為 `projects/goodlab-system/rulesets/476a4e21-7877-42b7-8db0-071f7a9e770e`。若必須回復，協調恢復上述網站與 Admin-only 維修規則。舊規則不認可新 `member_access`，也不允許一般客戶端讀取新增集合。舊管理員登錄保持不變。

不要把根目錄 `firestore.rules` 當成回復來源。資料回復只能針對本次建立／修改的文件，先核對遷移後 updateTime，避免覆寫上線後使用者的新資料；備份不是直接全表覆蓋的許可。GitHub 或 Firebase 任一階段失敗時須報告實際完成狀態，不宣稱整體發布成功。

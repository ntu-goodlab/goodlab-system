# GOODLAB 正式上線檢查表

## A. 本機版本

- [x] 一般成員使用說明與首次登入說明
- [x] 一般成員導覽與 Admin 控制項分離
- [x] 值日生／代班前端權限檢查
- [x] 維修描述、解決方案與產編備註輸出轉義
- [x] 手機版產編欄位與操作整理
- [x] GAS 上線狀態檢查函式
- [x] 自動測試與正式建置通過

## B. Firebase（發布網站前）

- [ ] 確認 `admins/{你的 Firebase UID}` 文件存在
- [ ] 確認成員的 `Email` 是正確的學校通知信箱（通常為學號@ntu.edu.tw）
- [ ] 將專案根目錄 `firestore.rules` 完整貼到 Firestore Rules 並發布
- [ ] 用 Admin 與一般成員各測一次：一般成員能載入公開公告／行事，但不能讀寫帳務、聘僱或維修紀錄

## C. GAS（正式啟用寄信）

- [ ] 將最新版 `gas/Code.gs` 與 `gas/appsscript.json` 貼入 GOODLAB Apps Script 專案
- [ ] 設定 `FIREBASE_PROJECT_ID`
- [ ] 設定 `GOODLAB_SITE_URL=https://ntu-goodlab.github.io/goodlab-system/`
- [ ] 五封測試信皆只寄到 `f10943138@ntu.edu.tw` 且內容正常
- [ ] 執行一次 `installTriggers`
- [ ] 執行 `verifyLaunchReadiness`，結果為 `READY`
- [ ] 左側「觸發條件」只有三筆 GOODLAB 排程

## D. GitHub Pages

- [ ] Commit 並 push 到 `ntu-goodlab/goodlab-system` 的 `main`
- [ ] GitHub Actions 的 Pages workflow 顯示成功
- [ ] 正式網址可登入且 favicon、路由與重新整理正常

## E. 一般成員實機驗收

- [ ] 新同學：Google 登入 → 顯示登入信箱 → 輸入自己的學號 → 綁定成功
- [ ] 綁定後（或既有成員重新登入一次後），Admin 能看到正確的 `Google_Display_Name` 與 `Google_Email`
- [ ] 已被其他 Google 帳號綁定的學號不能再次認領
- [ ] 一般成員只看到：總覽、值日生工作、產編清點、實驗室成員、儀器設備
- [ ] 非當週值日生不能勾選、提交或邀請代班
- [ ] 當週值日生能儲存備註、完成清單並提交
- [ ] 產編關閉時唯讀；開放時可更新狀態、區域與細項位置
- [ ] 一般成員總覽不顯示「回報設備問題」，且不能建立或讀取維修紀錄
- [ ] 已綁定的畢業成員仍可登入

四個區塊全部完成後再通知全體成員使用；不要只以 Admin 帳號驗收。

## F. 上線後待辦

- [ ] 重新評估開放「一般成員回報設備問題」。恢復前需先統一舊儀器的 `Is_Active` 布林格式、將表單簡化為直接選擇「儀器名稱｜區域」、補齊一般成員寫入規則與實際帳號測試。目前入口已隱藏，Firestore 也不允許一般成員建立維修紀錄。

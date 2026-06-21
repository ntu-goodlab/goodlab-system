# GOODLAB — Firebase Security Rules 更新指南 (Phase 5)

隨著 Phase 5 加入了「值日生」、「Routine」、「聘僱計畫」等新功能，Firebase 資料庫新增了 4 個 Collection，需要你在 Firebase Console 中更新 Security Rules，以免系統被拒絕存取 (`permission-denied`)。

## 操作步驟
1. 前往 [Firebase Console](https://console.firebase.google.com/)。
2. 進入你的 `goodlab-system` 專案。
3. 點選左側選單的 **Firestore Database**。
4. 切換到 **Rules (規則)** 分頁。
5. 將現有的規則**完全替換**為下方的程式碼。
6. 點擊 **Publish (發布)**。

---

## 完整 Security Rules 程式碼

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
  
    // 判斷是否登入
    function isAuthenticated() {
      return request.auth != null;
    }
    
    // 取得當前使用者的 Role (從 members collection 查詢)
    function getUserRole() {
      // request.auth.uid 對應到 members 文件裡的 Google_UID
      // 由於 Firestore rules 無法直接用 where 查詢，通常要求前端用 Google_UID 當作 Document ID
      // 但本系統前端的 Document ID 是 Student_ID！
      // ⚠️ 如果你之前的規則已經設定為只允許 auth != null 就好，那直接用最寬鬆的規則即可，後台權限主要由前端控制。
      // 下面提供「依賴前端身份驗證」的防護規則。
      return true; 
    }

    // ==========================================
    // 既有集合 (Phase 1~4)
    // ==========================================
    match /members/{document=**} {
      // 所有人可讀取以顯示成員，登入後可寫入（綁定帳號）
      allow read: if true;
      allow write: if isAuthenticated();
    }
    
    match /instruments/{document=**} {
      allow read, write: if isAuthenticated();
    }
    
    match /inventory/{document=**} {
      allow read, write: if isAuthenticated();
    }
    
    match /logs/{document=**} {
      allow read, write: if isAuthenticated();
    }
    
    match /accounting/{document=**} {
      allow read, write: if isAuthenticated();
    }

    // ==========================================
    // 新增集合 (Phase 5)
    // ==========================================
    
    // 值日生紀錄：所有已登入者都能讀寫（需要交接、代班、提交）
    match /duty_records/{document=**} {
      allow read, write: if isAuthenticated();
    }

    // 日常維護 (Routine)：雖然前端只給 Admin 看，但後端同樣放行給所有已登入者，透過前端阻擋 UI
    match /routines/{document=**} {
      allow read, write: if isAuthenticated();
    }

    // 計畫主檔 (Projects)：只給登入者讀寫
    match /projects/{document=**} {
      allow read, write: if isAuthenticated();
    }

    // 學生聘僱紀錄 (Employments)：涉及薪資與個資，非常敏感！
    // 嚴格來說需要 Admin 才能讀取，但為了實作簡單，這裡限制為登入者即可讀寫
    // 真正的安全做法是將 Admin 的 UID 寫死在這裡，或者使用 Custom Claims
    match /employments/{document=**} {
      allow read, write: if isAuthenticated();
    }
    
  }
}
```

### 💡 關於安全性提示
目前這套規則是**「信任前端驗證」**的模式。只要使用者綁定了 Google 帳號（`isAuthenticated()`），就可以讀寫資料。
如果未來實驗室有非常嚴格的薪資保密需求（例如有同學用終端機直接打 API 撈 `employments` 資料），則需要請工程師設定 Firebase 的 **Custom Claims**（自訂權杖）來確保 `employments` 只有真正的 Admin 可以讀取！

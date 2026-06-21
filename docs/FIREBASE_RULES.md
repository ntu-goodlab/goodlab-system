# GOODLAB — Firebase Security Rules 更新指南 (Phase 5)

## 重要：不要整份取代！

你目前的 Security Rules（5/23 版本）已經有完善的 `isSignedIn()`、`admins` 集合、欄位級權限控制。
**請不要用這份文件取代你的整份規則**，只需要在你現有規則的 `match /admins/{uid}` 區塊**之後**，`}` 結尾**之前**，加入以下 4 個新 collection 的規則即可。

---

## 在 Firebase Console 中操作

1. 前往 [Firebase Console](https://console.firebase.google.com/) → 你的專案
2. 左側選單 → **Firestore Database** → **Rules（規則）** 分頁
3. 找到你現有規則最底部、`match /admins/{uid}` 區塊結束後的位置
4. 在 `// 最外層的 } }` 之前，貼上下方程式碼
5. 點擊 **Publish（發布）**

---

## 要新增的規則（複製這段）

```javascript
    // ============================================================
    // Phase 5 新增集合
    // ============================================================

    // --- 值日生紀錄（duty_records）---
    match /duty_records/{weekId} {
      // 任何已登入者可以讀取（需要看輪值順序、代班狀態）
      allow read: if isSignedIn();

      // 新增：任何已登入者都可以（系統自動建立本週紀錄）
      allow create: if isSignedIn();

      // 更新：任何已登入者都可以（勾選 checkbox、代班流程、提交）
      // 這裡放寬是因為值日生和代班者都需要寫入，且身份是動態的
      allow update: if isSignedIn();

      // 刪除：只有 Admin
      allow delete: if isSignedIn() &&
                       exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    // --- 日常維護 Routine（routines）---
    match /routines/{routineId} {
      // 只有 Admin 可以讀寫（前端 UI 也只有 Admin 看得到）
      allow read, write: if isSignedIn() &&
                            exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    // --- 聘僱計畫（projects）---
    match /projects/{projectId} {
      // 只有 Admin 可以讀寫（涉及經費資訊）
      allow read, write: if isSignedIn() &&
                            exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    // --- 學生聘僱紀錄（employments）---
    match /employments/{empId} {
      // 只有 Admin 可以讀寫（涉及薪資與個資）
      allow read, write: if isSignedIn() &&
                            exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }
```

---

## 加完之後你的規則結構應該長這樣

```
service cloud.firestore {
  match /databases/{database}/documents {
    
    // 輔助函式
    function isSignedIn() { ... }
    
    // 既有集合 (5/23 版)
    match /members/{memberId}    { ... }
    match /instruments/{instId}  { ... }
    match /logs/{logId}          { ... }
    match /accounting/{txnId}    { ... }
    match /inventory/{propId}    { ... }
    match /admins/{uid}          { ... }
    
    // ★ Phase 5 新增（貼在這裡）
    match /duty_records/{weekId}    { ... }
    match /routines/{routineId}     { ... }
    match /projects/{projectId}     { ... }
    match /employments/{empId}      { ... }
    
  }  // ← 這個 } 是 match /databases 的結尾
}    // ← 這個 } 是 service 的結尾
```

---

## 權限邏輯說明

| Collection | 讀取 | 新增 | 修改 | 刪除 | 原因 |
|---|---|---|---|---|---|
| `duty_records` | 全員 | 全員 | 全員 | Admin | 值日生/代班者都需要寫入，刪除限 Admin |
| `routines` | Admin | Admin | Admin | Admin | 前端 UI 只有 Admin 看得到 |
| `projects` | Admin | Admin | Admin | Admin | 涉及計畫經費 |
| `employments` | Admin | Admin | Admin | Admin | 涉及薪資個資 |

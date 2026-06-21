# GOODLAB — GAS (Google Apps Script) 自動寄信設定指南

為了實作「值日生交接信」、「未完成提醒信」與「每週 Admin 週報」，我們將使用 Google Apps Script (GAS) 作為後端寄信服務器。

---

## 部署步驟

### Step 1：建立 GAS 專案
1. 使用實驗室的 Google 帳號（有 Gmail 的那個），前往 [script.google.com](https://script.google.com/)。
2. 點擊左上角「新專案 (New Project)」。
3. 將專案名稱重新命名為「GoodLab 自動寄信系統」。

### Step 2：貼上程式碼
請將預設的 `Code.gs` 清空，並貼上以下完整程式碼。

**⚠️ 注意：開始前必須填入兩個值**
- `PROJECT_ID`：你的 Firebase Project ID（在 Firebase Console → ⚙️ 專案設定中找到）
- `FIREBASE_API_KEY`：你的 Firebase Web API Key（同上頁面可以找到，或者是你 `.env` 裡的 `VITE_FIREBASE_API_KEY`）

```javascript
// ==========================================
// GOODLAB - 自動寄信與排程系統 (Phase 5)
// ==========================================

const PROJECT_ID = "你的_FIREBASE_PROJECT_ID";    // ★ 必填
const FIREBASE_API_KEY = "你的_FIREBASE_API_KEY";  // ★ 必填 (與前端 .env 中的 VITE_FIREBASE_API_KEY 相同)

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/"
                     + PROJECT_ID
                     + "/databases/(default)/documents/";

// ==========================================
// 1. Webhook 接收端
//    前端提交值日生工作後，會打這個 API 來寄信
// ==========================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.to && payload.subject && payload.body) {
      MailApp.sendEmail({
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.body
      });
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: 'Missing parameters' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 2. 值日生未完成提醒
//    排程：每週四 22:00~23:00
//    只寄給當週值日生本人
// ==========================================
function checkDutyReminder() {
  const members = fetchCollection("members");
  const dutyRecords = fetchCollection("duty_records");

  // 計算本週一日期 (與前端 _getDutyWeekId 相同邏輯)
  const weekId = getMondayDateStr(new Date());
  const currentRecord = dutyRecords.find(function(r) { return r._id === weekId; });

  if (currentRecord && currentRecord.assigned_to && !currentRecord.submitted) {
    var person = members.find(function(m) { return m.Student_ID === currentRecord.assigned_to; });
    if (person && person.Email) {
      MailApp.sendEmail({
        to: person.Email,
        subject: "【GOODLAB 友善提醒】本週值日生工作尚未完成 (" + weekId + ")",
        htmlBody: '<div style="font-family:sans-serif; line-height:1.6; color:#333;">'
          + '<h2 style="color:#f59e0b;">⚠️ 值日生工作提醒</h2>'
          + '<p>Hi <b>' + person.Name_Ch + '</b>：</p>'
          + '<p>這是一封系統友善提醒信。系統偵測到本週（' + weekId + ' 起）的實驗室值日生工作尚未完成提交。</p>'
          + '<p>請盡快抽空完成「一般清潔」與「耗材清點」，並登入系統進行勾選與提交！</p>'
          + '</div>'
      });
      console.log("提醒信已寄給: " + person.Name_Ch + " (" + person.Email + ")");
    }
  } else {
    console.log("本週值日生已完成或無紀錄，不需寄信。");
  }
}

// ==========================================
// 3. Admin 每週報表
//    排程：每週一 08:00~09:00
//    寄給所有 Admin
// ==========================================
function checkWeeklyAdminReport() {
  var members = fetchCollection("members");
  var dutyRecords = fetchCollection("duty_records");
  var routines = fetchCollection("routines");
  var logs = fetchCollection("logs");
  var accounting = fetchCollection("accounting");

  // Admin 信箱
  var adminEmails = members
    .filter(function(m) { return m.Role === "Admin" && m.Status === "Active" && m.Email; })
    .map(function(m) { return m.Email; })
    .join(",");
  if (!adminEmails) { console.log("無 Admin 信箱"); return; }

  var todayStr = new Date().toISOString().split("T")[0];

  // 「上週一」= 本週一 - 7 天
  var thisMonday = getMondayDateStr(new Date());
  var lastMondayDate = new Date(thisMonday);
  lastMondayDate.setDate(lastMondayDate.getDate() - 7);
  var lastMonday = lastMondayDate.toISOString().split("T")[0];

  // (1) 值日生狀態
  var lastWeekRecord = dutyRecords.find(function(r) { return r._id === lastMonday; });
  var dutyHtml;
  if (lastWeekRecord) {
    var person = members.find(function(m) { return m.Student_ID === lastWeekRecord.assigned_to; });
    var pName = person ? person.Name_Ch : lastWeekRecord.assigned_to;
    if (lastWeekRecord.submitted) {
      dutyHtml = '<p>✅ 上週值日生 (' + pName + ') <b>已完成</b>工作。</p>';
    } else {
      dutyHtml = '<p style="color:#dc2626;">❌ <b>警告：</b>上週值日生 (' + pName + ') <b>未完成/未提交</b>工作！</p>';
    }
  } else {
    dutyHtml = '<p>上週無排定值日生紀錄。</p>';
  }

  // (2) Routine
  var routineHtml = "";
  var overdueRoutines = routines.filter(function(r) { return r.next_due && r.next_due < todayStr; });
  var soonRoutines = routines.filter(function(r) {
    if (!r.next_due) return false;
    var dueTime = new Date(r.next_due).getTime();
    var todayTime = new Date().getTime();
    return dueTime >= todayTime && dueTime <= (todayTime + 7 * 86400000);
  });

  if (overdueRoutines.length > 0) {
    routineHtml += '<h4 style="color:#dc2626;">🔴 已逾期項目：</h4><ul>';
    overdueRoutines.forEach(function(r) { routineHtml += '<li><b>' + r.name + '</b> (原到期日: ' + r.next_due + ')</li>'; });
    routineHtml += '</ul>';
  }
  if (soonRoutines.length > 0) {
    routineHtml += '<h4 style="color:#f59e0b;">⚠️ 本週即將到期：</h4><ul>';
    soonRoutines.forEach(function(r) { routineHtml += '<li><b>' + r.name + '</b> (到期日: ' + r.next_due + ')</li>'; });
    routineHtml += '</ul>';
  }
  if (!routineHtml) routineHtml = '<p>✅ 所有項目皆正常，本週無待辦。</p>';

  // (3) Logs
  var unresolvedLogs = logs.filter(function(l) { return l.Status !== "resolved"; });
  var recentLogs = logs.filter(function(l) { return l.Created_At && l.Created_At >= lastMonday; });

  var logsHtml = '<h4>📌 上週新增紀錄：</h4>';
  if (recentLogs.length > 0) {
    logsHtml += '<ul>';
    recentLogs.forEach(function(l) {
      var desc = l.Description || '';
      logsHtml += '<li>' + (l.Inst_ID || '?') + ' - ' + (l.Issue_Type || '?') + ' (' + (l.Status || '?') + '): ' + desc + '</li>';
    });
    logsHtml += '</ul>';
  } else {
    logsHtml += '<p>無新增紀錄。</p>';
  }

  logsHtml += '<h4>🔥 累積未解決紀錄：</h4>';
  if (unresolvedLogs.length > 0) {
    logsHtml += '<ul>';
    unresolvedLogs.forEach(function(l) {
      var desc = (l.Description || '').substring(0, 30);
      logsHtml += '<li><b>' + (l.Inst_ID || '?') + '</b>：' + (l.Issue_Type || '') + ' (' + desc + '...)</li>';
    });
    logsHtml += '</ul>';
  } else {
    logsHtml += '<p>✅ 目前無積壓問題。</p>';
  }

  // (4) 帳務
  var recentAcc = accounting.filter(function(a) { return a.Created_At && a.Created_At >= lastMonday; });
  var accHtml = '<h4>💰 上週新增帳務：</h4>';
  if (recentAcc.length > 0) {
    accHtml += '<ul>';
    recentAcc.forEach(function(a) {
      var amount = a.Amount > 0 ? ('+' + a.Amount) : a.Amount;
      accHtml += '<li>' + (a.Date || '?') + ' | ' + (a.Type || '') + ' | ' + (a.Description || '') + ' (' + amount + ' 元)</li>';
    });
    accHtml += '</ul>';
  } else {
    accHtml += '<p>無新增帳務。</p>';
  }

  // 組合寄送
  var body = '<div style="font-family:sans-serif; line-height:1.6; color:#333; max-width:600px;">'
    + '<h2 style="color:#2563eb;">📊 GOODLAB 實驗室每週報表 (' + todayStr + ')</h2>'
    + '<hr>'
    + '<h3>1️⃣ 值日生狀況</h3>' + dutyHtml
    + '<hr>'
    + '<h3>2️⃣ Routine 日常維護</h3>' + routineHtml
    + '<hr>'
    + '<h3>3️⃣ 機台維修 Logs</h3>' + logsHtml
    + '<hr>'
    + '<h3>4️⃣ 公積金異動</h3>' + accHtml
    + '<hr>'
    + '<p style="font-size:0.8rem; color:#666;">此信件由 GoodLab 系統自動發送，請勿直接回覆。</p>'
    + '</div>';

  MailApp.sendEmail({
    to: adminEmails,
    subject: "【GOODLAB 每週報表】" + todayStr + " 狀態總覽",
    htmlBody: body
  });

  console.log("週報已寄給: " + adminEmails);
}

// ==========================================
// 工具函數
// ==========================================

// 計算指定日期所在週的「週一」日期字串 (YYYY-MM-DD)
function getMondayDateStr(date) {
  var d = new Date(date);
  var day = d.getDay();
  var diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  // 手動格式化避免時區問題 (GAS 的 toISOString 是 UTC)
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

// 讀取 Firestore REST API（使用 API Key 繞過 Security Rules 的 auth 需求）
// ⚠️ 注意：Firestore REST API + API Key 只能讀取「allow read: if true」的集合
// 若你的 Security Rules 全部都要求 isAuthenticated()，
// 你需要把 GAS 的 Google 帳號加入 Firebase 專案的「服務帳戶」，
// 然後用 ScriptApp.getOAuthToken() 取得 Token（見下方 fetchCollectionWithAuth）。
function fetchCollection(collectionName) {
  // 先嘗試用 OAuth Token（GAS 帳號需是 Firebase 專案的成員）
  var token = ScriptApp.getOAuthToken();
  var url = FIRESTORE_BASE + collectionName;
  var options = {
    method: "get",
    headers: { "Authorization": "Bearer " + token },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);

  if (response.getResponseCode() !== 200) {
    console.error("Error fetching " + collectionName + " (HTTP " + response.getResponseCode() + "): " + response.getContentText());
    return [];
  }

  var json = JSON.parse(response.getContentText());
  if (!json.documents) return [];

  return json.documents.map(function(doc) {
    var data = {};
    for (var key in doc.fields) {
      data[key] = parseFirestoreValue(doc.fields[key]);
    }
    data._id = doc.name.split('/').pop();
    return data;
  });
}

function parseFirestoreValue(valueObj) {
  if (!valueObj) return null;
  var type = Object.keys(valueObj)[0];
  var val = valueObj[type];
  switch (type) {
    case 'stringValue':    return val;
    case 'integerValue':   return parseInt(val, 10);
    case 'doubleValue':    return parseFloat(val);
    case 'booleanValue':   return val;
    case 'timestampValue': return val;
    case 'arrayValue':     return (val.values || []).map(parseFirestoreValue);
    case 'mapValue':
      var map = {};
      if (val.fields) {
        for (var k in val.fields) {
          map[k] = parseFirestoreValue(val.fields[k]);
        }
      }
      return map;
    case 'nullValue':      return null;
    default:               return val;
  }
}
```

---

### Step 3：將 GAS 帳號加入 Firebase 專案（讓 GAS 有權讀 Firestore）

GAS 程式碼中的 `fetchCollection` 使用 `ScriptApp.getOAuthToken()` 取得 GAS 執行帳號的 OAuth Token 來讀取 Firestore。為了讓這個 Token 有效，**你需要把執行 GAS 的 Google 帳號加入 Firebase 專案成員**：

1. 前往 [Firebase Console](https://console.firebase.google.com/) → 你的專案。
2. 點擊左上角 ⚙️ 齒輪 → **「使用者和權限」**。
3. 點擊 **「新增成員」**。
4. 輸入你用來執行 GAS 的 Google 帳號 Email。
5. 角色選擇 **「檢視者 (Viewer)」** 就夠了（只需要讀取）。
6. 點擊「完成」。

> 如果你的 GAS 帳號就是 Firebase 專案的擁有者，這步可以跳過。

### Step 4：部署 Webhook API

1. 在 GAS 編輯器右上角，點擊 **「部署 (Deploy)」 → 「新增部署作業 (New deployment)」**。
2. 點擊齒輪圖示 ⚙️，選擇 **「網頁應用程式 (Web app)」**。
3. 填寫描述：`GoodLab API v1`。
4. **執行身分 (Execute as)**：選擇 **「我 (Me)」**。
5. **存取權限 (Who has access)**：選擇 **「所有人 (Anyone)」**。
6. 點擊 **「部署」**。
7. (初次授權) Google 會跳出警告 → 點擊「審查權限」→ 選帳號 →「進階」→「前往 GoodLab 自動寄信系統(不安全)」→「允許」。
8. 複製得到的 **Web app URL**（長得像 `https://script.google.com/macros/s/XXXXX/exec`）。

### Step 5：將 Webhook URL 貼回前端程式碼

打開 `src/constants.js`，找到最底部的：
```javascript
export const GAS_WEBHOOK_URL = "";
```
將空字串改成你剛拿到的 URL：
```javascript
export const GAS_WEBHOOK_URL = "https://script.google.com/macros/s/XXXXX/exec";
```

### Step 6：設定時間觸發器（排程自動寄信）

1. 在 GAS 編輯器左側選單，點擊 **「觸發條件 (Triggers)」** ⏰。
2. 點擊右下角 **「新增觸發條件」**。

**觸發器 A：值日生週四提醒**
| 設定項目 | 值 |
|---|---|
| 執行的功能 | `checkDutyReminder` |
| 事件來源 | 時間驅動 |
| 類型 | 週計時器 |
| 星期幾 | 每週四 |
| 時段 | 下午 10 點到 11 點 |

**觸發器 B：Admin 週一報表**
| 設定項目 | 值 |
|---|---|
| 執行的功能 | `checkWeeklyAdminReport` |
| 事件來源 | 時間驅動 |
| 類型 | 週計時器 |
| 星期幾 | 每週一 |
| 時段 | 上午 8 點到 9 點 |

### Step 7：測試

1. 回到 GAS 編輯器。
2. 在函式下拉選單中選擇 `checkWeeklyAdminReport`。
3. 按下 ▶️ 執行。
4. 到 Admin 的信箱確認是否收到測試週報。
5. 如果出現錯誤，按下方的「執行紀錄」查看 log。

---

🎉 **全部設定完成！**

### 整體流程回顧

| 事件 | 觸發方式 | 收件者 | 時機 |
|---|---|---|---|
| 值日生交接公告 | Webhook（前端提交時打 API） | 全實驗室 Active 成員 | 值日生按「提交」時 |
| 值日生未完成提醒 | GAS 排程 | 當週值日生本人 | 每週四 22:00-23:00 |
| Admin 週報 | GAS 排程 | 所有 Admin | 每週一 08:00-09:00 |

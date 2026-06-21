# GOODLAB — GAS (Google Apps Script) 自動寄信設定指南

---

## Step 1：建立 GAS 專案
1. 使用實驗室的 Google 帳號，前往 [script.google.com](https://script.google.com/)。
2. 點擊「新專案」，重新命名為「GoodLab 自動寄信系統」。

## Step 2：貼上程式碼

將預設的 `Code.gs` 清空，貼上以下完整程式碼。

**必填兩個值：**
- `PROJECT_ID`：Firebase Console → ⚙️ 專案設定 → 專案 ID
- `FIREBASE_API_KEY`：同頁面，或你 `.env` 裡的 `VITE_FIREBASE_API_KEY`

```javascript
// ==========================================
// GOODLAB - 自動寄信與排程系統 (Phase 5)
// ==========================================

var PROJECT_ID = "你的_FIREBASE_PROJECT_ID";
var FIREBASE_API_KEY = "你的_FIREBASE_API_KEY";

var FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/"
                   + PROJECT_ID
                   + "/databases/(default)/documents/";

// ==========================================
// 0. 測試用：手動執行這個函式來驗證
//    會寄一封測試週報到你自己的信箱
// ==========================================
function testSendToMe() {
  var myEmail = Session.getActiveUser().getEmail();
  console.log("測試信將寄給: " + myEmail);

  // 測試 Firestore 連線
  var members = fetchCollection("members");
  console.log("members 筆數: " + members.length);

  if (members.length === 0) {
    console.error("無法讀取 members！請確認：");
    console.error("1. PROJECT_ID 是否正確");
    console.error("2. 此 GAS 帳號是否已加入 Firebase 專案成員");
    return;
  }

  var logs = fetchCollection("logs");
  console.log("logs 筆數: " + logs.length);

  var routines = fetchCollection("routines");
  console.log("routines 筆數: " + routines.length);

  // 寄一封簡易測試信
  MailApp.sendEmail({
    to: myEmail,
    subject: "【GOODLAB 測試】GAS 連線測試成功",
    htmlBody: '<div style="font-family:sans-serif; line-height:1.6; color:#333;">'
      + '<h2>GAS 系統測試報告</h2>'
      + '<p>Firestore 連線成功！以下是讀取到的資料筆數：</p>'
      + '<ul>'
      + '<li>members: ' + members.length + ' 筆</li>'
      + '<li>logs: ' + logs.length + ' 筆</li>'
      + '<li>routines: ' + routines.length + ' 筆</li>'
      + '</ul>'
      + '<p>如果以上數字都正確，代表系統已經可以正常運作。</p>'
      + '</div>'
  });

  console.log("測試信已寄出！");
}

// ==========================================
// 1. Webhook 接收端
//    前端提交值日生工作後，會打這個 API 來寄信
// ==========================================
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

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
        .createTextOutput(JSON.stringify({ success: false, error: "Missing parameters" }))
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
  var members = fetchCollection("members");
  var dutyRecords = fetchCollection("duty_records");

  var weekId = getMondayDateStr(new Date());
  var currentRecord = dutyRecords.find(function(r) { return r._id === weekId; });

  if (currentRecord && currentRecord.assigned_to && !currentRecord.submitted) {
    var person = members.find(function(m) { return m.Student_ID === currentRecord.assigned_to; });
    if (person && person.Email) {
      MailApp.sendEmail({
        to: person.Email,
        subject: "【GOODLAB】友善提醒，本週值日生工作尚未完成 (" + weekId + ")",
        htmlBody: '<div style="font-family:sans-serif; line-height:1.6; color:#333;">'
          + '<h2 style="color:#f59e0b;">值日生工作提醒</h2>'
          + '<p>Hi <b>' + person.Name_Ch + '</b>，</p>'
          + '<p>本週（' + weekId + ' 起）的實驗室值日生工作尚未完成提交。</p>'
          + '<p>請盡快完成一般清潔與耗材清點，並登入系統勾選提交。</p>'
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

  var thisMonday = getMondayDateStr(new Date());
  var lastMondayDate = new Date(thisMonday);
  lastMondayDate.setDate(lastMondayDate.getDate() - 7);
  var lastMonday = lastMondayDate.toISOString().split("T")[0];

  // --- (1) 值日生狀態 ---
  var lastWeekRecord = dutyRecords.find(function(r) { return r._id === lastMonday; });
  var dutyHtml;
  if (lastWeekRecord) {
    var person = members.find(function(m) { return m.Student_ID === lastWeekRecord.assigned_to; });
    var pName = person ? person.Name_Ch : lastWeekRecord.assigned_to;
    if (lastWeekRecord.submitted) {
      dutyHtml = '<p>上週值日生 (' + pName + ') 已完成工作。</p>';
    } else {
      dutyHtml = '<p style="color:#dc2626;"><b>警告：</b>上週值日生 (' + pName + ') 未完成/未提交工作！</p>';
    }
  } else {
    dutyHtml = '<p>上週無排定值日生紀錄。</p>';
  }

  // --- (2) Routine ---
  var routineHtml = "";
  var overdueRoutines = routines.filter(function(r) { return r.next_due && r.next_due < todayStr; });
  var soonRoutines = routines.filter(function(r) {
    if (!r.next_due) return false;
    var dueTime = new Date(r.next_due).getTime();
    var todayTime = new Date().getTime();
    return dueTime >= todayTime && dueTime <= (todayTime + 7 * 86400000);
  });

  if (overdueRoutines.length > 0) {
    routineHtml += '<h4 style="color:#dc2626;">已逾期項目：</h4><ul>';
    overdueRoutines.forEach(function(r) { routineHtml += '<li><b>' + r.name + '</b> (原到期日: ' + r.next_due + ')</li>'; });
    routineHtml += '</ul>';
  }
  if (soonRoutines.length > 0) {
    routineHtml += '<h4 style="color:#f59e0b;">本週即將到期：</h4><ul>';
    soonRoutines.forEach(function(r) { routineHtml += '<li><b>' + r.name + '</b> (到期日: ' + r.next_due + ')</li>'; });
    routineHtml += '</ul>';
  }
  if (!routineHtml) routineHtml = '<p>所有項目皆正常，本週無待辦。</p>';

  // --- (3) Logs ---
  var unresolvedLogs = logs.filter(function(l) { return l.Status !== "resolved"; });
  var recentLogs = logs.filter(function(l) { return l.Created_At && l.Created_At >= lastMonday; });

  var logsHtml = '<h4>上週新增紀錄：</h4>';
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

  logsHtml += '<h4>累積未解決紀錄：</h4>';
  if (unresolvedLogs.length > 0) {
    logsHtml += '<ul>';
    unresolvedLogs.forEach(function(l) {
      var desc = (l.Description || '').substring(0, 30);
      logsHtml += '<li><b>' + (l.Inst_ID || '?') + '</b>：' + (l.Issue_Type || '') + ' (' + desc + '...)</li>';
    });
    logsHtml += '</ul>';
  } else {
    logsHtml += '<p>目前無積壓問題。</p>';
  }

  // --- (4) 帳務 ---
  var recentAcc = accounting.filter(function(a) { return a.Created_At && a.Created_At >= lastMonday; });
  var accHtml = '<h4>上週新增帳務：</h4>';
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

  // --- 組合寄送 ---
  var body = '<div style="font-family:sans-serif; line-height:1.6; color:#333; max-width:600px;">'
    + '<h2 style="color:#2563eb;">GOODLAB 實驗室每週報表 (' + todayStr + ')</h2>'
    + '<hr>'
    + '<h3>1. 值日生狀況</h3>' + dutyHtml
    + '<hr>'
    + '<h3>2. Routine 日常維護</h3>' + routineHtml
    + '<hr>'
    + '<h3>3. 機台維修 Logs</h3>' + logsHtml
    + '<hr>'
    + '<h3>4. 公積金異動</h3>' + accHtml
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

function getMondayDateStr(date) {
  var d = new Date(date);
  var day = d.getDay();
  var diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

function fetchCollection(collectionName) {
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

## Step 3：確認 GAS 帳號有 Firebase 權限

GAS 用 `ScriptApp.getOAuthToken()` 讀 Firestore，所以執行 GAS 的 Google 帳號必須是 Firebase 專案的成員。

> 如果你的 GAS 帳號就是 Firebase 專案擁有者，這步可以跳過。

否則：Firebase Console → ⚙️ → 使用者和權限 → 新增成員 → 填入 GAS 帳號 Email → 角色選「檢視者」。

## Step 4：先測試！

1. 在 GAS 編輯器上方的函式下拉選單，選 **`testSendToMe`**。
2. 按 ▶️ 執行。
3. 初次會跳出授權視窗 → 審查權限 → 進階 → 前往專案 → 允許。
4. 看下方的「執行紀錄」：
   - 如果看到 `members 筆數: XX` 且數字正確 → Firestore 連線成功
   - 如果看到 `Error fetching members (HTTP 403)` → GAS 帳號沒有 Firebase 權限，回 Step 3
5. 去收信，應該會收到一封「GAS 連線測試成功」的信。

## Step 5：部署 Webhook

測試通過後再部署：

1. 部署 → 新增部署作業 → 網頁應用程式
2. 執行身分：我
3. 存取權限：所有人
4. 部署 → 複製 Web app URL
5. 貼回 `src/constants.js` 的 `GAS_WEBHOOK_URL`

## Step 6：設定排程觸發器

觸發條件 → 新增觸發條件：

| 函式 | 類型 | 時間 |
|---|---|---|
| `checkDutyReminder` | 週計時器 / 每週四 / 22:00-23:00 |
| `checkWeeklyAdminReport` | 週計時器 / 每週一 / 08:00-09:00 |

---

## 寄信事件總覽

| 事件 | 觸發 | 收件者 |
|---|---|---|
| 值日生交接公告 | Webhook（前端提交時） | 全體 Active 成員 |
| 值日生未完成提醒 | 排程 週四 22:00 | 當週值日生本人 |
| Admin 週報 | 排程 週一 08:00 | 所有 Admin |

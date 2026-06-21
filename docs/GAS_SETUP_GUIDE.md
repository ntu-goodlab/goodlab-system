# GOODLAB — GAS (Google Apps Script) 自動寄信設定指南

為了實作「值日生交接信」、「未完成提醒信」與「每週 Admin 週報」，我們將使用 Google Apps Script (GAS) 作為後端寄信服務器。

## 部署步驟

### 1. 建立 GAS 專案
1. 使用具有 Gmail 權限的 Google 帳號，前往 [Google Apps Script 首頁](https://script.google.com/)。
2. 點擊左上角「新專案 (New Project)」。
3. 將專案名稱重新命名為「GoodLab 自動寄信系統」。

### 2. 貼上程式碼
請將預設的 `Code.gs` 清空，並貼上以下完整程式碼。
**⚠️ 注意：** 請將程式碼第一行的 `PROJECT_ID` 替換為你在 Firebase Console 中的真實 Project ID（例如 `goodlab-system-xxxx`）。

```javascript
// ==========================================
// GOODLAB - 自動寄信與排程系統 (Phase 5)
// ==========================================

const PROJECT_ID = "你的_FIREBASE_PROJECT_ID_請填這裡"; // ★ 請替換為你的 Firebase Project ID
const FIRESTORE_API_URL = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/";

// ==========================================
// 1. Webhook 接收端 (處理前端主動觸發的信件)
// ==========================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    
    // 前端只要負責組好信件的 收件人、主旨、內容 傳過來即可
    if (payload.to && payload.subject && payload.body) {
      MailApp.sendEmail({
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.body
      });
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Missing parameters' })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// 處理預檢請求 (CORS)
function doOptions(e) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 2. 值日生未完成提醒 (排程：週四 23:00)
// ==========================================
function checkDutyReminder() {
  const members = fetchCollection('members');
  const dutyRecords = fetchCollection('duty_records');
  
  // 計算本週一的日期作為 Week ID
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  const weekId = monday.toISOString().split('T')[0];
  
  const currentRecord = dutyRecords.find(r => r._id === weekId);
  
  // 如果還沒提交，寄信給當週負責人
  if (currentRecord && currentRecord.assigned_to && !currentRecord.submitted) {
    const person = members.find(m => m.Student_ID === currentRecord.assigned_to);
    if (person && person.Email) {
      const subject = `【GOODLAB 友善提醒】本週值日生工作尚未完成 (${weekId})`;
      const body = `
        <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #f59e0b;">⚠️ 值日生工作提醒</h2>
          <p>Hi <b>${person.Name_Ch}</b>：</p>
          <p>這是一封系統友善提醒信。系統偵測到本週（${weekId} 起）的實驗室值日生工作尚未完成提交。</p>
          <p>請盡快抽空完成「一般清潔」與「耗材清點」，並登入系統進行勾選與提交！</p>
          <p>👉 <a href="https://你的網域" style="display:inline-block; padding:10px 20px; background:#2563eb; color:white; text-decoration:none; border-radius:6px;">前往系統</a></p>
        </div>
      `;
      MailApp.sendEmail({ to: person.Email, subject: subject, htmlBody: body });
    }
  }
}

// ==========================================
// 3. Admin 每週報表 (排程：週一 08:00)
// ==========================================
function checkWeeklyAdminReport() {
  const members = fetchCollection('members');
  const dutyRecords = fetchCollection('duty_records');
  const routines = fetchCollection('routines');
  const logs = fetchCollection('logs');
  const accounting = fetchCollection('accounting');
  
  // 取得 Admin 信箱名單
  const adminEmails = members.filter(m => m.Role === 'Admin' && m.Status === 'Active' && m.Email).map(m => m.Email).join(',');
  if (!adminEmails) return;
  
  const todayDate = new Date();
  const todayStr = todayDate.toISOString().split('T')[0];
  const lastWeekDate = new Date();
  lastWeekDate.setDate(todayDate.getDate() - 7);
  const lastWeekStr = lastWeekDate.toISOString().split('T')[0];

  // (1) 值日生狀態 (檢查上一週是否完成)
  let dutyHtml = '';
  const lastWeekId = lastWeekStr; // 上週一是 7 天前
  const lastWeekRecord = dutyRecords.find(r => r._id === lastWeekId);
  if (lastWeekRecord) {
    const person = members.find(m => m.Student_ID === lastWeekRecord.assigned_to);
    const pName = person ? person.Name_Ch : lastWeekRecord.assigned_to;
    if (lastWeekRecord.submitted) {
      dutyHtml = `<p>✅ 上週值日生 (${pName}) <b>已完成</b> 工作。</p>`;
    } else {
      dutyHtml = `<p style="color: #dc2626;">❌ <b>警告：</b>上週值日生 (${pName}) <b>未完成/未提交</b> 工作！</p>`;
    }
  } else {
    dutyHtml = `<p>上週無排定值日生。</p>`;
  }

  // (2) Routine 狀態
  let routineHtml = '';
  const overdueRoutines = routines.filter(r => r.next_due && r.next_due < todayStr);
  const dueThisWeekRoutines = routines.filter(r => {
    if (!r.next_due) return false;
    const dueTime = new Date(r.next_due).getTime();
    return dueTime >= todayDate.getTime() && dueTime <= (todayDate.getTime() + 7*86400000);
  });
  
  if (overdueRoutines.length > 0) {
    routineHtml += `<h4 style="color:#dc2626;">🔴 已逾期項目：</h4><ul>`;
    overdueRoutines.forEach(r => routineHtml += `<li><b>${r.name}</b> (原到期日: ${r.next_due})</li>`);
    routineHtml += `</ul>`;
  }
  if (dueThisWeekRoutines.length > 0) {
    routineHtml += `<h4 style="color:#f59e0b;">⚠️ 本週即將到期：</h4><ul>`;
    dueThisWeekRoutines.forEach(r => routineHtml += `<li><b>${r.name}</b> (到期日: ${r.next_due})</li>`);
    routineHtml += `</ul>`;
  }
  if (!routineHtml) routineHtml = '<p>✅ 所有項目皆正常，本週無待辦 Routine。</p>';

  // (3) Logs 機台紀錄
  const unresolvedLogs = logs.filter(l => l.Status !== 'resolved');
  const recentLogs = logs.filter(l => l.Created_At && l.Created_At >= lastWeekStr);
  
  let logsHtml = '<h4>📌 上週新增紀錄：</h4>';
  if (recentLogs.length > 0) {
    logsHtml += '<ul>';
    recentLogs.forEach(l => logsHtml += `<li>${l.Inst_ID} - ${l.Issue_Type} (${l.Status}): ${l.Description}</li>`);
    logsHtml += '</ul>';
  } else {
    logsHtml += '<p>無新增紀錄。</p>';
  }
  
  logsHtml += '<h4>🔥 累積未解決紀錄：</h4>';
  if (unresolvedLogs.length > 0) {
    logsHtml += '<ul>';
    unresolvedLogs.forEach(l => logsHtml += `<li><b>${l.Inst_ID}</b>：${l.Issue_Type} (${l.Description.substring(0,20)}...)</li>`);
    logsHtml += '</ul>';
  } else {
    logsHtml += '<p>✅ 目前無積壓問題。</p>';
  }

  // (4) 帳務更新
  const recentAcc = accounting.filter(a => a.Created_At && a.Created_At >= lastWeekStr);
  let accHtml = '<h4>💰 上週新增帳務：</h4>';
  if (recentAcc.length > 0) {
    accHtml += '<ul>';
    recentAcc.forEach(a => {
      const amount = a.Amount > 0 ? `+${a.Amount}` : a.Amount;
      accHtml += `<li>${a.Date} | ${a.Type} | ${a.Description} (${amount} 元)</li>`;
    });
    accHtml += '</ul>';
  } else {
    accHtml += '<p>無新增帳務。</p>';
  }

  // 組合並發送
  const body = `
    <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px;">
      <h2 style="color: #2563eb;">📊 GOODLAB 實驗室每週報表 (${todayStr})</h2>
      <hr>
      <h3>1️⃣ 值日生狀況</h3>
      ${dutyHtml}
      <hr>
      <h3>2️⃣ Routine 日常維護</h3>
      ${routineHtml}
      <hr>
      <h3>3️⃣ 機台維修 Logs</h3>
      ${logsHtml}
      <hr>
      <h3>4️⃣ 公積金異動</h3>
      ${accHtml}
      <hr>
      <p style="font-size: 0.8rem; color: #666;">此信件由 GoodLab 系統自動發送，請勿直接回覆。</p>
    </div>
  `;
  
  MailApp.sendEmail({
    to: adminEmails,
    subject: `【GOODLAB 每週報表】${todayStr} 狀態總覽`,
    htmlBody: body
  });
}

// ==========================================
// 工具函數：讀取 Firestore REST API
// ==========================================
function fetchCollection(collectionName) {
  const url = FIRESTORE_API_URL + collectionName;
  const options = { method: "get", muteHttpExceptions: true };
  const response = UrlFetchApp.fetch(url, options);
  
  if (response.getResponseCode() !== 200) {
    console.error("Error fetching " + collectionName + ": " + response.getContentText());
    return [];
  }
  
  const json = JSON.parse(response.getContentText());
  if (!json.documents) return [];
  
  return json.documents.map(doc => {
    let data = {};
    for (let key in doc.fields) {
      data[key] = parseFirestoreValue(doc.fields[key]);
    }
    data._id = doc.name.split('/').pop();
    return data;
  });
}

function parseFirestoreValue(valueObj) {
  if (!valueObj) return null;
  const type = Object.keys(valueObj)[0];
  const val = valueObj[type];
  switch (type) {
    case 'stringValue': return val;
    case 'integerValue': return parseInt(val, 10);
    case 'doubleValue': return parseFloat(val);
    case 'booleanValue': return val;
    case 'timestampValue': return val;
    case 'arrayValue': return (val.values || []).map(parseFirestoreValue);
    case 'mapValue': 
      const map = {};
      if(val.fields) {
        for (let k in val.fields) {
          map[k] = parseFirestoreValue(val.fields[k]);
        }
      }
      return map;
    case 'nullValue': return null;
    default: return val;
  }
}
```

### 3. 部署 Webhook API (讓前端可以打 API 寄信)
1. 在 GAS 編輯器右上角，點擊 **「部署 (Deploy)」 > 「新增部署作業 (New deployment)」**。
2. 點擊齒輪圖示 ⚙️，選擇 **「網頁應用程式 (Web app)」**。
3. 填寫描述（例如：GoodLab API v1）。
4. **存取權限 (Who has access)**：選擇 **「所有人 (Anyone)」**。（這是 Webhook 必須的設定）
5. 點擊 **「部署」**。
6. (初次授權) Google 會跳出警告視窗，點擊「審查權限」-> 選擇帳號 ->「進階」->「前往專案(不安全)」->「允許」。
7. 部署完成後，會得到一組 **「網頁應用程式網址 (Web app URL)」**，長得像：`https://script.google.com/macros/s/XXXXX/exec`。
8. **將這串網址複製下來，等等要貼到專案的 `constants.js` 中！**

### 4. 設定時間觸發器 (Cron Jobs)
讓報表與提醒可以自動寄出。
1. 在 GAS 編輯器左側選單，點擊 **「觸發條件 (Triggers)」** (一個時鐘的圖示 ⏰)。
2. 點擊右下角 **「新增觸發條件」**。
3. **新增【週四提醒信】**：
   - 選擇執行的功能：`checkDutyReminder`
   - 選取事件來源：`時間驅動 (Time-driven)`
   - 選取時間型觸發條件的類型：`週計時器 (Week timer)`
   - 選取星期幾：`每週四`
   - 選取時段：`下午 10 點到下午 11 點` (這會在這一個小時內隨機觸發，GAS 無法指定精準的分鐘)
   - 點擊「儲存」。
4. **新增【Admin 週報信】**：
   - 選擇執行的功能：`checkWeeklyAdminReport`
   - 選取事件來源：`時間驅動`
   - 選取時間型觸發條件的類型：`週計時器`
   - 選取星期幾：`每週一`
   - 選取時段：`上午 8 點到上午 9 點`
   - 點擊「儲存」。

---

🎉 **到這裡 GAS 就設定完成了！**
下一步：將你剛才拿到的 `Web app URL` 更新到程式碼中。

/**
 * GOODLAB 排程寄信（Google Apps Script）
 *
 * 僅處理固定排程：
 * - 每週四：值日工作未完成提醒（含未完成順延）
 * - 每週一：Admin 週報（含順延狀態）
 *
 * 不提供 doGet/doPost，也不接受前端指定收件者或信件 HTML。
 */

const TIME_ZONE = 'Asia/Taipei';
const FIRESTORE_PAGE_SIZE = 300;
const MAX_EMAIL_LIST_ITEMS = 20;
const DUTY_COMPLETION_SENT_PREFIX = 'DUTY_COMPLETION_SENT_';
const PROPERTY_KEYS = {
  projectId: 'FIREBASE_PROJECT_ID',
  siteUrl: 'GOODLAB_SITE_URL'
};

function testSendToMe() {
  runJob_('TEST', function () {
    const recipient = Session.getEffectiveUser().getEmail();
    if (!recipient) throw new Error('無法取得目前 GAS 帳號 Email。');

    const members = fetchCollection_('members');
    const logs = fetchCollection_('logs');
    const routines = fetchCollection_('routines');

    sendEmail_({
      to: recipient,
      subject: '【GOODLAB 測試】GAS 連線與寄信成功',
      htmlBody: emailLayout_(
        'GAS 連線測試成功',
        '<p>Firestore 已可讀取，資料筆數如下：</p>'
          + '<ul>'
          + '<li>members：' + members.length + ' 筆</li>'
          + '<li>logs：' + logs.length + ' 筆</li>'
          + '<li>routines：' + routines.length + ' 筆</li>'
          + '</ul>'
          + '<p>此測試信寄送至建立與執行此 GAS 專案的帳號。</p>'
      )
    });
  });
}

function testDutyReminderToMe() {
  runJob_('TEST_DUTY_REMINDER', function () {
    const recipient = Session.getEffectiveUser().getEmail();
    if (!recipient) throw new Error('無法取得目前 GAS 帳號 Email。');

    const weekId = mondayDateKey_(new Date());
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const record = resolveDutyRecordForWeek_(dutyRecords, weekId);
    const person = record && record.assigned_to
      ? members.find(function (member) { return member.Student_ID === record.assigned_to; })
      : null;
    const previewPerson = person || { Name_Ch: '值日生同學', Student_ID: 'PREVIEW' };

    sendEmail_(buildDutyReminderMessage_(previewPerson, weekId, recipient, true, record));
    console.log('值日提醒預覽已寄給目前 GAS 帳號：' + recipient);
  });
}

function testDutyCompletionToMe() {
  runJob_('TEST_DUTY_COMPLETION', function () {
    const recipient = Session.getEffectiveUser().getEmail();
    if (!recipient) throw new Error('無法取得目前 GAS 帳號 Email。');

    const weekId = mondayDateKey_(new Date());
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const existing = dutyRecords.find(function (item) { return item._id === weekId; });
    const previewRecord = Object.assign({
      _id: weekId,
      week_start: weekId,
      scheduled_to: members[0] ? members[0].Student_ID : 'PREVIEW',
      assigned_to: members[0] ? members[0].Student_ID : 'PREVIEW',
      submitted: true
    }, existing || {});
    previewRecord.note = previewRecord.note || '預覽範例：已補充手套；IPA 已叫貨，預計下週到。';
    previewRecord.submitted = true;

    sendEmail_(buildDutyCompletionMessage_(previewRecord, members, dutyRecords, recipient, true));
    console.log('值日完成通知預覽已寄給目前 GAS 帳號：' + recipient);
  });
}

function checkDutyReminder() {
  runJob_('DUTY_REMINDER', function () {
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const weekId = mondayDateKey_(new Date());
    const record = resolveDutyRecordForWeek_(dutyRecords, weekId);

    if (!record || !record.assigned_to) {
      console.log('找不到本週值日生或可順延的未完成紀錄，不寄信。');
      return;
    }
    if (record.submitted) {
      console.log('本週值日工作已提交，不寄信。');
      return;
    }

    const person = members.find(function (member) {
      return member.Student_ID === record.assigned_to;
    });
    if (!person || !isEmail_(person.Email)) {
      throw new Error('本週值日生沒有有效 Email：' + record.assigned_to);
    }

    sendEmail_(buildDutyReminderMessage_(person, weekId, person.Email, false, record));
    console.log('值日提醒已寄給 ' + person.Student_ID);
  });
}

function buildDutyReminderMessage_(person, weekId, recipient, isPreview, record) {
  const safeName = escapeHtml_(person.Name_Ch || person.Student_ID);
  const carryoverHtml = record && record.assignment_source === 'carryover'
    ? '<p style="padding:12px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;color:#9a3412;">'
      + '<strong>順延提醒：</strong>前一週（' + escapeHtml_(record.carried_from || '未標示週次') + ' 起）尚未完成，因此本週仍由你繼續，完成後才會輪到下一位。</p>'
    : '';
  return {
    to: recipient,
    subject: (isPreview ? '【GOODLAB 測試預覽】' : '【GOODLAB】') + '本週值日工作尚未完成（' + weekId + '）',
    htmlBody: emailLayout_(
      '值日工作提醒',
      '<p>' + safeName + '：</p>'
        + '<p>本週（' + weekId + ' 起）的值日工作尚未完成提交，請完成一般清潔與耗材清點，確認所有項目後在系統送出。</p>'
        + carryoverHtml
        + siteLinkHtml_('前往值日生清單', 'duty')
        + siteUrlTextHtml_('duty')
        + '<div style="margin-top:22px;padding:16px;background:#f1f5f9;border:1px solid #dce3ec;border-radius:10px;">'
        + '<strong style="display:block;margin-bottom:6px;">首次登入注意事項</strong>'
        + '<ol style="margin:0;padding-left:20px;">'
        + '<li>點選右上角「Google 登入」，請使用自己的 Google 帳號，不要使用共用帳號。</li>'
        + '<li>首次登入會要求輸入學號；該學號須已由 Admin 建立，完成後即會綁定此 Google 帳號。</li>'
        + '<li>完成綁定後，從選單進入「值日生工作」即可清點與提交；若無法綁定，請聯絡 Admin。</li>'
        + '</ol></div>'
    )
  };
}

function checkDutyCompletionNotification() {
  runJob_('DUTY_COMPLETION', function () {
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const thisWeek = mondayDateKey_(new Date());
    const candidateWeekIds = [shiftDateKey_(thisWeek, -7), thisWeek];
    const properties = PropertiesService.getScriptProperties();
    const pendingRecords = dutyRecords
      .filter(function (record) {
        if (!record.submitted || candidateWeekIds.indexOf(record._id) === -1) return false;
        return !properties.getProperty(dutyCompletionPropertyKey_(record._id));
      })
      .sort(function (a, b) { return String(a._id).localeCompare(String(b._id)); });

    if (!pendingRecords.length) {
      console.log('目前沒有尚未寄送的值日完成通知。');
      return;
    }

    const senderEmail = Session.getEffectiveUser().getEmail();
    if (!senderEmail) throw new Error('無法取得目前 GAS 帳號 Email。');
    const studentEmails = getActiveStudentEmails_(members)
      .filter(function (email) { return email.toLowerCase() !== senderEmail.toLowerCase(); });
    if (!studentEmails.length) throw new Error('找不到 Active 在學成員的有效 Email。');

    pendingRecords.forEach(function (record) {
      sendEmail_(buildDutyCompletionMessage_(
        record,
        members,
        dutyRecords,
        senderEmail,
        false,
        studentEmails.join(',')
      ));
      properties.setProperty(
        dutyCompletionPropertyKey_(record._id),
        String(record.submitted_at || new Date().toISOString())
      );
      console.log('值日完成通知已寄給 ' + studentEmails.length + ' 位在學成員：' + record._id);
    });
  });
}

function buildDutyCompletionMessage_(record, members, dutyRecords, recipient, isPreview, bcc) {
  const weekId = record.week_start || record._id;
  const scheduledTo = record.scheduled_to || record.assigned_to;
  const assignedTo = record.assigned_to || scheduledTo;
  const scheduledMember = members.find(function (member) { return member.Student_ID === scheduledTo; });
  const assignedMember = members.find(function (member) { return member.Student_ID === assignedTo; });
  const nextMember = getNextDutyMember_(record, members, dutyRecords);
  const assignedName = escapeHtml_(assignedMember ? assignedMember.Name_Ch : (assignedTo || '未指定'));
  const scheduledName = escapeHtml_(scheduledMember ? scheduledMember.Name_Ch : (scheduledTo || '未指定'));
  const nextName = escapeHtml_(nextMember ? nextMember.Name_Ch : '尚未指定');
  const note = String(record.note || '').trim();
  const noteHtml = note
    ? '<div style="padding:14px 16px;background:#f1f5f9;border:1px solid #dce3ec;border-radius:10px;white-space:normal;overflow-wrap:anywhere;">'
      + escapeHtml_(note).replace(/\r?\n/g, '<br>') + '</div>'
    : '<p style="color:#526075;">本週沒有補充備註。</p>';
  const substituteHtml = assignedTo !== scheduledTo
    ? '<p style="color:#526075;">原排定：' + scheduledName + '；本週由 ' + assignedName + ' 代班完成。後續輪值仍依原排定順序。</p>'
    : '';
  const carryoverHtml = record.assignment_source === 'carryover'
    ? '<p style="color:#9a3412;">此工作由 ' + escapeHtml_(record.carried_from || '前一週') + ' 起的未完成紀錄順延；本次完成後才恢復正常輪值。</p>'
    : '';

  return {
    to: recipient,
    bcc: bcc || '',
    subject: (isPreview ? '【GOODLAB 測試預覽】' : '【GOODLAB】') + '本週值日工作已完成（' + weekId + '）',
    htmlBody: emailLayout_(
      '本週值日工作已完成',
      '<p><strong>' + assignedName + '</strong> 已提交 ' + escapeHtml_(weekId) + ' 起的值日工作。</p>'
        + carryoverHtml
        + substituteHtml
        + sectionHtml_('本週備註／補貨與叫貨', noteHtml)
        + sectionHtml_('下週值日生', '<p><strong>' + nextName + '</strong></p>')
        + siteLinkHtml_('查看值日生紀錄', 'duty')
        + siteUrlTextHtml_('duty')
    )
  };
}

function checkWeeklyAdminReport() {
  runJob_('WEEKLY_ADMIN_REPORT', function () {
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const routines = fetchCollection_('routines');
    const logs = fetchCollection_('logs');
    const accounting = fetchCollection_('accounting');

    const adminEmails = members
      .filter(function (member) {
        return member.Role === 'Admin' && member.Status === 'Active' && isEmail_(member.Email);
      })
      .map(function (member) { return member.Email; })
      .filter(unique_);
    if (!adminEmails.length) throw new Error('找不到 Active Admin 的有效 Email。');

    const today = dateKey_(new Date());
    const thisMonday = mondayDateKey_(new Date());
    const lastMonday = shiftDateKey_(thisMonday, -7);
    const lastSunday = shiftDateKey_(thisMonday, -1);

    const dutyHtml = buildDutySummary_(dutyRecords, members, lastMonday, thisMonday);
    const routineHtml = buildRoutineSummary_(routines, today);
    const logsHtml = buildLogsSummary_(logs, lastMonday, thisMonday);
    const accountingHtml = buildAccountingSummary_(accounting, lastMonday, thisMonday);

    const reportBody = '<p style="color:#526075;">報表期間：' + lastMonday + '～' + lastSunday + '</p>'
      + sectionHtml_('1. 值日生狀況', dutyHtml)
      + sectionHtml_('2. Routine', routineHtml)
      + sectionHtml_('3. 維修紀錄', logsHtml)
      + sectionHtml_('4. 公積金異動', accountingHtml)
      + siteLinkHtml_('開啟 GOODLAB');

    sendEmail_({
      to: adminEmails.join(','),
      subject: '【GOODLAB 每週報表】' + today + ' 狀態總覽',
      htmlBody: emailLayout_('GOODLAB 實驗室每週報表', reportBody)
    });
    console.log('週報已寄給 ' + adminEmails.length + ' 位 Admin。');
  });
}

function installTriggers() {
  const managedHandlers = ['checkDutyReminder', 'checkDutyCompletionNotification', 'checkWeeklyAdminReport'];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (managedHandlers.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('checkDutyReminder')
    .timeBased()
    .inTimezone(TIME_ZONE)
    .onWeekDay(ScriptApp.WeekDay.THURSDAY)
    .atHour(22)
    .create();

  ScriptApp.newTrigger('checkWeeklyAdminReport')
    .timeBased()
    .inTimezone(TIME_ZONE)
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();

  ScriptApp.newTrigger('checkDutyCompletionNotification')
    .timeBased()
    .everyMinutes(15)
    .create();

  console.log('已建立週四值日提醒、每 15 分鐘值日完成通知與週一 Admin 週報觸發器。');
}

function removeManagedTriggers() {
  const managedHandlers = ['checkDutyReminder', 'checkDutyCompletionNotification', 'checkWeeklyAdminReport'];
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (managedHandlers.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  console.log('GOODLAB 排程觸發器已移除。');
}

function showAutomationStatus() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  console.log(JSON.stringify({
    projectConfigured: Boolean(properties[PROPERTY_KEYS.projectId]),
    siteUrlConfigured: Boolean(properties[PROPERTY_KEYS.siteUrl]),
    remainingDailyQuota: MailApp.getRemainingDailyQuota(),
    lastSuccessDutyReminder: properties.LAST_SUCCESS_DUTY_REMINDER || null,
    lastSuccessDutyCompletion: properties.LAST_SUCCESS_DUTY_COMPLETION || null,
    lastSuccessWeeklyReport: properties.LAST_SUCCESS_WEEKLY_ADMIN_REPORT || null,
    lastErrorDutyReminder: properties.LAST_ERROR_DUTY_REMINDER || null,
    lastErrorDutyCompletion: properties.LAST_ERROR_DUTY_COMPLETION || null,
    lastErrorWeeklyReport: properties.LAST_ERROR_WEEKLY_ADMIN_REPORT || null,
    triggers: ScriptApp.getProjectTriggers().map(function (trigger) {
      return trigger.getHandlerFunction();
    })
  }, null, 2));
}

function resolveDutyRecordForWeek_(records, weekId) {
  const currentRecord = records.find(function (item) { return item._id === weekId; }) || null;
  if (currentRecord && (
    currentRecord.submitted
    || currentRecord.assignment_source === 'admin'
    || currentRecord.assignment_source === 'substitute'
    || currentRecord.assignment_source === 'carryover'
    || hasDutyProgress_(currentRecord)
  )) {
    return currentRecord;
  }

  const previousRecord = records
    .filter(function (item) { return item._id < weekId; })
    .sort(function (a, b) { return String(b._id).localeCompare(String(a._id)); })[0] || null;
  if (!previousRecord || previousRecord.submitted) return currentRecord;

  const scheduledTo = previousRecord.scheduled_to || previousRecord.assigned_to;
  const assignedTo = previousRecord.assigned_to || scheduledTo;
  return Object.assign({}, currentRecord || {}, {
    _id: weekId,
    week_start: weekId,
    scheduled_to: scheduledTo,
    assigned_to: assignedTo,
    assignment_source: 'carryover',
    carried_from: previousRecord._id,
    carryover_count: Number(previousRecord.carryover_count || 0) + 1,
    submitted: false
  });
}

function hasDutyProgress_(record) {
  if (!record) return false;
  const cleaning = record.cleaning || {};
  const supplies = record.supplies || {};
  return Boolean(
    String(record.note || '').trim()
    || record.substitute_pending
    || Object.keys(cleaning).some(function (key) { return Boolean(cleaning[key]); })
    || Object.keys(supplies).some(function (key) { return Boolean(supplies[key]); })
  );
}

function buildDutySummary_(records, members, weekId, currentWeekId) {
  const record = records.find(function (item) { return item._id === weekId; });
  if (!record) return '<p>上週沒有值日生紀錄。</p>';

  const person = members.find(function (member) { return member.Student_ID === record.assigned_to; });
  const name = escapeHtml_(person ? person.Name_Ch : (record.assigned_to || '未指定'));
  if (record.submitted) return '<p>上週值日生（' + name + '）已完成提交。</p>';

  const currentRecord = resolveDutyRecordForWeek_(records, currentWeekId);
  const currentPerson = currentRecord
    ? members.find(function (member) { return member.Student_ID === currentRecord.assigned_to; })
    : null;
  const currentName = escapeHtml_(currentPerson
    ? currentPerson.Name_Ch
    : (currentRecord && currentRecord.assigned_to) || '未指定');

  if (currentRecord && currentRecord.assignment_source === 'carryover' && currentRecord.carried_from === weekId) {
    return '<p style="color:#b91c1c;"><strong>上週未完成：</strong>值日生（' + name + '）尚未提交，已順延至本週由 <strong>' + currentName + '</strong> 繼續。</p>';
  }
  if (currentRecord && currentRecord.assignment_source === 'admin') {
    return '<p style="color:#b91c1c;"><strong>上週未完成：</strong>值日生（' + name + '）尚未提交；本週已由 Admin 指定 <strong>' + currentName + '</strong>，因此未自動順延。</p>';
  }
  return '<p style="color:#b91c1c;"><strong>待確認：</strong>上週值日生（' + name + '）尚未提交，且目前無法確認本週承接者。</p>';
}

function buildRoutineSummary_(routines, today) {
  const soonLimit = shiftDateKey_(today, 7);
  const overdue = routines
    .filter(function (routine) { return routine.next_due && routine.next_due < today; })
    .sort(byNextDue_);
  const soon = routines
    .filter(function (routine) {
      return routine.next_due && routine.next_due >= today && routine.next_due <= soonLimit;
    })
    .sort(byNextDue_);

  if (!overdue.length && !soon.length) return '<p>未發現逾期或七天內到期項目。</p>';

  let html = '';
  if (overdue.length) {
    html += '<h4 style="color:#b91c1c;">已逾期</h4>'
      + limitedListHtml_(overdue, function (routine) {
        return '<strong>' + escapeHtml_(routine.name || '未命名') + '</strong>（' + escapeHtml_(routine.next_due) + '）';
      });
  }
  if (soon.length) {
    html += '<h4 style="color:#b45309;">七天內到期</h4>'
      + limitedListHtml_(soon, function (routine) {
        return '<strong>' + escapeHtml_(routine.name || '未命名') + '</strong>（' + escapeHtml_(routine.next_due) + '）';
      });
  }
  return html;
}

function buildLogsSummary_(logs, rangeStart, rangeEnd) {
  const recent = logs
    .filter(function (log) {
      const date = String(log.Date_Reported || '').slice(0, 10);
      return date >= rangeStart && date < rangeEnd;
    })
    .sort(function (a, b) { return String(b.Date_Reported || '').localeCompare(String(a.Date_Reported || '')); });
  const unresolved = logs.filter(function (log) { return log.Status !== 'Closed'; });

  return '<p>上週新增：<strong>' + recent.length + '</strong> 筆；目前未結案：<strong>' + unresolved.length + '</strong> 筆。</p>'
    + (recent.length ? limitedListHtml_(recent, function (log) {
      return escapeHtml_(log.Instrument_ID || '未指定儀器')
        + '：' + escapeHtml_(truncate_(log.Problem_Desc || '未填描述', 80));
    }) : '<p>上週沒有新增維修紀錄。</p>');
}

function buildAccountingSummary_(accounting, rangeStart, rangeEnd) {
  const recent = accounting
    .filter(function (item) {
      const date = String(item.Created_At || item.Date || '').slice(0, 10);
      return date >= rangeStart && date < rangeEnd;
    })
    .sort(function (a, b) {
      return String(b.Created_At || b.Date || '').localeCompare(String(a.Created_At || a.Date || ''));
    });

  if (!recent.length) return '<p>上週沒有新增帳務紀錄。</p>';
  return '<p>上週新增：<strong>' + recent.length + '</strong> 筆。</p>'
    + limitedListHtml_(recent, function (item) {
      const amount = Number(item.Amount) || 0;
      return escapeHtml_(String(item.Date || '').slice(0, 10) || '未填日期')
        + '｜' + escapeHtml_(item.Description || '未填項目')
        + '｜' + formatMoney_(amount);
    });
}

function fetchCollection_(collectionName) {
  const projectId = getRequiredProperty_(PROPERTY_KEYS.projectId);
  const token = ScriptApp.getOAuthToken();
  const baseUrl = 'https://firestore.googleapis.com/v1/projects/'
    + encodeURIComponent(projectId)
    + '/databases/(default)/documents/'
    + encodeURIComponent(collectionName);
  let pageToken = '';
  let documents = [];

  do {
    const url = baseUrl + '?pageSize=' + FIRESTORE_PAGE_SIZE
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    const body = response.getContentText();
    if (status !== 200) {
      throw new Error('讀取 Firestore ' + collectionName + ' 失敗（HTTP ' + status + '）：' + truncate_(body, 300));
    }

    const payload = JSON.parse(body || '{}');
    documents = documents.concat(payload.documents || []);
    pageToken = payload.nextPageToken || '';
  } while (pageToken);

  return documents.map(function (document) {
    const data = {};
    Object.keys(document.fields || {}).forEach(function (key) {
      data[key] = parseFirestoreValue_(document.fields[key]);
    });
    data._id = document.name.split('/').pop();
    return data;
  });
}

function parseFirestoreValue_(valueObject) {
  if (!valueObject) return null;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'stringValue')) return valueObject.stringValue;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'integerValue')) return Number(valueObject.integerValue);
  if (Object.prototype.hasOwnProperty.call(valueObject, 'doubleValue')) return Number(valueObject.doubleValue);
  if (Object.prototype.hasOwnProperty.call(valueObject, 'booleanValue')) return valueObject.booleanValue;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'timestampValue')) return valueObject.timestampValue;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'referenceValue')) return valueObject.referenceValue;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'bytesValue')) return valueObject.bytesValue;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'geoPointValue')) return valueObject.geoPointValue;
  if (Object.prototype.hasOwnProperty.call(valueObject, 'arrayValue')) {
    return (valueObject.arrayValue.values || []).map(parseFirestoreValue_);
  }
  if (Object.prototype.hasOwnProperty.call(valueObject, 'mapValue')) {
    const result = {};
    Object.keys(valueObject.mapValue.fields || {}).forEach(function (key) {
      result[key] = parseFirestoreValue_(valueObject.mapValue.fields[key]);
    });
    return result;
  }
  return null;
}

function runJob_(jobName, callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log(jobName + ' 已有執行中的工作，本次略過。');
    return;
  }

  const properties = PropertiesService.getScriptProperties();
  try {
    callback();
    properties.setProperty('LAST_SUCCESS_' + jobName, new Date().toISOString());
    properties.deleteProperty('LAST_ERROR_' + jobName);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    properties.setProperty('LAST_ERROR_' + jobName, new Date().toISOString() + '｜' + truncate_(message, 500));
    console.error(jobName + ' 失敗：' + message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function sendEmail_(message) {
  const requiredQuota = countEmailRecipients_(message.to)
    + countEmailRecipients_(message.cc)
    + countEmailRecipients_(message.bcc);
  const remainingQuota = MailApp.getRemainingDailyQuota();
  if (remainingQuota < requiredQuota) {
    throw new Error('GAS 今日寄信配額不足：需要 ' + requiredQuota + '，剩餘 ' + remainingQuota + '。');
  }
  const options = {
    to: message.to,
    subject: message.subject,
    htmlBody: message.htmlBody,
    name: 'GOODLAB'
  };
  if (message.cc) options.cc = message.cc;
  if (message.bcc) options.bcc = message.bcc;
  MailApp.sendEmail(options);
}

function countEmailRecipients_(value) {
  return String(value || '')
    .split(',')
    .map(function (email) { return email.trim(); })
    .filter(Boolean)
    .length;
}

function emailLayout_(title, body) {
  return '<div style="font-family:Arial,\'Noto Sans TC\',sans-serif;line-height:1.7;color:#0f172a;max-width:680px;margin:auto;">'
    + '<h2 style="color:#1d4ed8;margin-bottom:8px;">' + escapeHtml_(title) + '</h2>'
    + body
    + '<hr style="border:0;border-top:1px solid #dce3ec;margin:24px 0;">'
    + '<p style="font-size:12px;color:#526075;">此信由 GOODLAB 排程寄送。若內容有誤，請由系統管理員檢查 Firestore 資料與 GAS 執行紀錄。</p>'
    + '</div>';
}

function sectionHtml_(title, content) {
  return '<section style="border-top:1px solid #dce3ec;padding-top:12px;margin-top:18px;">'
    + '<h3 style="font-size:17px;margin:0 0 8px;">' + escapeHtml_(title) + '</h3>'
    + content
    + '</section>';
}

function limitedListHtml_(items, renderItem) {
  const visible = items.slice(0, MAX_EMAIL_LIST_ITEMS);
  let html = '<ul>' + visible.map(function (item) { return '<li>' + renderItem(item) + '</li>'; }).join('') + '</ul>';
  if (items.length > visible.length) html += '<p>另有 ' + (items.length - visible.length) + ' 筆，請至系統查看。</p>';
  return html;
}

function siteLinkHtml_(label, route) {
  const url = siteUrl_(route);
  if (!url) return '';
  return '<p><a href="' + escapeHtml_(url) + '" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#1d4ed8;color:#fff;text-decoration:none;">'
    + escapeHtml_(label) + '</a></p>';
}

function siteUrlTextHtml_(route) {
  const url = siteUrl_(route);
  if (!url) return '';
  return '<p style="font-size:13px;color:#526075;word-break:break-all;">若按鈕無法開啟，可複製網址：<br>'
    + '<a href="' + escapeHtml_(url) + '" style="color:#1d4ed8;">' + escapeHtml_(url) + '</a></p>';
}

function siteUrl_(route) {
  const configuredUrl = (PropertiesService.getScriptProperties().getProperty(PROPERTY_KEYS.siteUrl) || '').trim();
  if (!/^https:\/\//i.test(configuredUrl)) return '';

  const cleanRoute = String(route || '').replace(/^#?\/?/, '').replace(/^\/+|\/+$/g, '');
  if (!cleanRoute) return configuredUrl;

  const baseUrl = configuredUrl.replace(/#.*$/, '').replace(/\/+$/, '');
  return baseUrl + '/#/' + cleanRoute;
}

function getRequiredProperty_(key) {
  const value = (PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  if (!value) throw new Error('尚未設定 Script Property：' + key);
  return value;
}

function getActiveStudentEmails_(members) {
  const studentDegrees = ['master', 'phd', 'bachelor', 'undergraduate', 'undergrad'];
  return members
    .filter(function (member) {
      return member.Status === 'Active'
        && studentDegrees.indexOf(String(member.Degree || '').toLowerCase()) !== -1
        && isEmail_(member.Email);
    })
    .map(function (member) { return String(member.Email).trim(); })
    .filter(unique_);
}

function getNextDutyMember_(record, members, dutyRecords) {
  const weekId = record.week_start || record._id;
  const nextWeekId = shiftDateKey_(weekId, 7);
  const nextRecord = dutyRecords.find(function (item) { return item._id === nextWeekId; });
  const nextAssignedTo = nextRecord && (nextRecord.assigned_to || nextRecord.scheduled_to);
  if (nextAssignedTo) {
    const explicitlyAssigned = members.find(function (member) { return member.Student_ID === nextAssignedTo; });
    if (explicitlyAssigned) return explicitlyAssigned;
  }

  const roster = members
    .filter(function (member) {
      return member.Degree === 'Master' && member.Role !== 'Admin' && member.Status === 'Active';
    })
    .sort(function (a, b) { return String(a.Student_ID).localeCompare(String(b.Student_ID)); });
  if (!roster.length) return null;

  const scheduledTo = record.scheduled_to || record.assigned_to;
  const currentIndex = roster.findIndex(function (member) { return member.Student_ID === scheduledTo; });
  return roster[(currentIndex >= 0 ? currentIndex + 1 : 0) % roster.length];
}

function dutyCompletionPropertyKey_(weekId) {
  return DUTY_COMPLETION_SENT_PREFIX + String(weekId || '').replace(/[^0-9A-Za-z_]/g, '_');
}

function dateKey_(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'yyyy-MM-dd');
}

function mondayDateKey_(date) {
  const isoDay = Number(Utilities.formatDate(date, TIME_ZONE, 'u'));
  return dateKey_(new Date(date.getTime() - (isoDay - 1) * 86400000));
}

function shiftDateKey_(dateKey, days) {
  const date = new Date(dateKey + 'T12:00:00+08:00');
  date.setTime(date.getTime() + days * 86400000);
  return dateKey_(date);
}

function formatMoney_(amount) {
  const rounded = Math.round(Number(amount) || 0);
  return (rounded >= 0 ? '+' : '-') + '$' + Math.abs(rounded).toLocaleString('zh-TW');
}

function escapeHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character];
  });
}

function truncate_(value, maxLength) {
  const text = String(value == null ? '' : value);
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function isEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function unique_(value, index, array) {
  return array.indexOf(value) === index;
}

function byNextDue_(a, b) {
  return String(a.next_due || '').localeCompare(String(b.next_due || ''));
}

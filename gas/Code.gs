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
const TEST_RECIPIENT_EMAIL = 'f10943138@ntu.edu.tw';
const DUTY_SUPPLY_NAMES = {
  acetone: 'Acetone',
  methanol: 'Methanol',
  detergent: 'Detergent',
  n2_tank: '氮氣鋼瓶',
  wiper: '無塵紙',
  glass_slide: '載玻片',
  gloves_s: '乳膠手套 S',
  gloves_m: '乳膠手套 M',
  gloves_l: '乳膠手套 L',
  cotton_swab: '棉花棒',
  aluminum_foil: '鋁箔',
  pe_gloves: 'PE 手套'
};
const PROPERTY_KEYS = {
  projectId: 'FIREBASE_PROJECT_ID',
  siteUrl: 'GOODLAB_SITE_URL'
};

function testSendToMe() {
  runJob_('TEST', function () {
    const recipient = TEST_RECIPIENT_EMAIL;

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
          + '<p>此測試信固定寄送至 ' + escapeHtml_(TEST_RECIPIENT_EMAIL) + '。</p>'
      )
    });
  });
}

function testDutyReminderToMe() {
  runJob_('TEST_DUTY_REMINDER', function () {
    const recipient = TEST_RECIPIENT_EMAIL;

    const weekId = mondayDateKey_(new Date());
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const record = resolveDutyRecordForWeek_(dutyRecords, weekId);
    const dutyRoster = getDutyRoster_(members);
    const person = record && record.assigned_to
      ? dutyRoster.find(function (member) { return member.Student_ID === record.assigned_to; })
      : null;
    const previewPerson = person || dutyRoster[0] || { Name_Ch: '值日生同學', Student_ID: 'PREVIEW' };

    sendEmail_(buildDutyReminderMessage_(previewPerson, weekId, recipient, true, record));
    console.log('值日提醒預覽已寄給測試信箱：' + recipient);
  });
}

function testDutyCompletionToMe() {
  runJob_('TEST_DUTY_COMPLETION', function () {
    const recipient = TEST_RECIPIENT_EMAIL;

    const weekId = mondayDateKey_(new Date());
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const dutyRoster = getDutyRoster_(members);
    const previewId = dutyRoster[0] ? dutyRoster[0].Student_ID : 'PREVIEW';
    const existing = dutyRecords.find(function (item) { return item._id === weekId; });
    const existingIsEligible = existing
      && dutyRoster.some(function (member) {
        return member.Student_ID === (existing.scheduled_to || existing.assigned_to);
      })
      && dutyRoster.some(function (member) {
        return member.Student_ID === (existing.assigned_to || existing.scheduled_to);
      });
    const previewRecord = Object.assign({
      _id: weekId,
      week_start: weekId,
      scheduled_to: previewId,
      assigned_to: previewId,
      submitted: true
    }, existingIsEligible ? existing : {});
    previewRecord.note = previewRecord.note || '預覽留言：機房地板有積水，請下週協助留意。';
    previewRecord.submitted = true;
    previewRecord.submitted_at = previewRecord.submitted_at || new Date().toISOString();
    previewRecord.supplies = {};
    Object.keys(DUTY_SUPPLY_NAMES).forEach(function (key) {
      previewRecord.supplies[key] = 'sufficient';
    });
    previewRecord.supplies.acetone = 'ordered';
    previewRecord.supplies.methanol = 'ordered';

    sendEmail_(buildDutyCompletionMessage_(previewRecord, members, dutyRecords, recipient, true));
    console.log('值日完成通知預覽已寄給測試信箱：' + recipient);
  });
}

function testMaintenanceSummaryToMe() {
  runJob_('TEST_MAINTENANCE_SUMMARY', function () {
    const recipient = TEST_RECIPIENT_EMAIL;

    const logs = fetchCollection_('logs');
    const instruments = fetchCollection_('instruments');
    const thisMonday = mondayDateKey_(new Date());
    const lastMonday = shiftDateKey_(thisMonday, -7);
    const lastSunday = shiftDateKey_(thisMonday, -1);
    const logsHtml = buildLogsSummary_(logs, instruments, lastMonday, thisMonday);

    sendEmail_({
      to: recipient,
      subject: '【GOODLAB 測試預覽】維修週報摘要',
      htmlBody: emailLayout_(
        '維修紀錄週報預覽',
        '<p style="color:#526075;">報表期間：' + lastMonday + '～' + lastSunday + '</p>'
          + sectionHtml_('維修紀錄', logsHtml)
          + siteLinkHtml_('查看維修紀錄', 'logs')
      )
    });
    console.log('維修週報預覽已寄給測試信箱：' + recipient);
  });
}

function testWeeklyAdminReportToMe() {
  runJob_('TEST_WEEKLY_ADMIN_REPORT', function () {
    const recipient = TEST_RECIPIENT_EMAIL;
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const routines = fetchCollection_('routines');
    const logs = fetchCollection_('logs');
    const instruments = fetchCollection_('instruments');
    const accounting = fetchCollection_('accounting');
    const today = dateKey_(new Date());
    const thisMonday = mondayDateKey_(new Date());
    const lastMonday = shiftDateKey_(thisMonday, -7);
    const lastSunday = shiftDateKey_(thisMonday, -1);
    const reportBody = '<p style="color:#526075;">報表期間：' + lastMonday + '～' + lastSunday + '</p>'
      + sectionHtml_('1. 值日生狀況', buildDutySummary_(dutyRecords, members, lastMonday, thisMonday))
      + sectionHtml_('2. 實驗室行事', buildRoutineSummary_(routines, today))
      + sectionHtml_('3. 維修紀錄', buildLogsSummary_(logs, instruments, lastMonday, thisMonday))
      + sectionHtml_('4. 公積金異動', buildAccountingSummary_(accounting, members, lastMonday, thisMonday))
      + siteLinkHtml_('開啟 GOODLAB');

    sendEmail_({
      to: recipient,
      subject: '【GOODLAB 測試預覽】' + today + ' 每週報表',
      htmlBody: emailLayout_('GOODLAB 實驗室每週報表預覽', reportBody)
    });
    console.log('完整每週報表預覽已寄給測試信箱：' + recipient);
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
    if (!person || !isDutyRosterMember_(person)) {
      console.log('本週輪值紀錄指向非在學輪值成員，已停止寄信：' + record.assigned_to);
      return;
    }
    if (!isEmail_(person.Email)) {
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
  const weekEndId = shiftDateKey_(weekId, 6);
  const nextWeekId = shiftDateKey_(weekId, 7);
  const nextWeekEndId = shiftDateKey_(weekId, 13);
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
    : '<p style="color:#526075;">無留言。</p>';
  const submittedAt = formatDutySubmittedAt_(record.submitted_at);
  const detailHtml = '<ul style="margin:0;padding-left:22px;">'
    + '<li><strong>值日生：</strong>' + assignedName + '</li>'
    + '<li><strong>值日期間：</strong>' + formatDutyDate_(weekId) + '～' + formatDutyDate_(weekEndId) + '</li>'
    + '<li><strong>提交時間：</strong>' + submittedAt + '</li>'
    + '</ul>';
  const nextDutyHtml = '<ul style="margin:0;padding-left:22px;">'
    + '<li><strong>值日生：</strong>' + nextName + '</li>'
    + '<li><strong>值日期間：</strong>' + formatDutyDate_(nextWeekId) + '～' + formatDutyDate_(nextWeekEndId) + '</li>'
    + '</ul>';
  const substituteHtml = assignedTo !== scheduledTo
    ? '<p style="color:#526075;">原排定：' + scheduledName + '；本週由 ' + assignedName + ' 代班完成。後續輪值仍依原排定順序。</p>'
    : '';
  const carryoverHtml = record.assignment_source === 'carryover'
    ? '<p style="color:#9a3412;">此工作由 ' + escapeHtml_(record.carried_from || '前一週') + ' 起的未完成紀錄順延；本次完成後才恢復正常輪值。</p>'
    : '';

  return {
    to: recipient,
    bcc: bcc || '',
    subject: (isPreview ? '【GOODLAB 測試預覽】' : '【GOODLAB】')
      + formatDutyDateRangeShort_(weekId, weekEndId) + ' 值日工作已完成',
    htmlBody: emailLayout_(
      formatDutyDateRangeShort_(weekId, weekEndId) + ' 值日工作',
      sectionHtml_('詳細資訊', detailHtml)
        + carryoverHtml
        + substituteHtml
        + sectionHtml_('耗材狀況', buildDutySupplySummaryHtml_(record.supplies || {}))
        + sectionHtml_('本週留言', noteHtml)
        + sectionHtml_('下週值日生資訊', nextDutyHtml)
        + siteLinkHtml_('查看值日生執行紀錄', 'duty-history')
        + siteUrlTextHtml_('duty-history')
    )
  };
}

function normalizeDutySupplyStatus_(value) {
  if (value === true) return 'legacy_checked';
  return ['sufficient', 'ordered', 'needs_order'].indexOf(value) !== -1 ? value : '';
}

function buildDutySupplySummaryHtml_(supplies) {
  const ordered = [];
  const needsOrder = [];
  const legacyChecked = [];
  const unconfirmed = [];

  Object.keys(DUTY_SUPPLY_NAMES).forEach(function (key) {
    const status = normalizeDutySupplyStatus_(supplies[key]);
    if (status === 'ordered') ordered.push(DUTY_SUPPLY_NAMES[key]);
    else if (status === 'needs_order') needsOrder.push(DUTY_SUPPLY_NAMES[key]);
    else if (status === 'legacy_checked') legacyChecked.push(DUTY_SUPPLY_NAMES[key]);
    else if (!status) unconfirmed.push(DUTY_SUPPLY_NAMES[key]);
  });

  if (!ordered.length && !needsOrder.length && !legacyChecked.length && !unconfirmed.length) {
    return '<p>本週無需叫貨。</p>';
  }

  if (legacyChecked.length === Object.keys(DUTY_SUPPLY_NAMES).length) {
    return '<p>已完成耗材清點；舊版資料未區分數量足夠或已叫貨。</p>';
  }

  let html = '<ul style="margin:0;padding-left:22px;">';
  html += '<li><strong>本週叫貨：</strong>' + (ordered.length ? escapeHtml_(ordered.join('、')) : '無') + '</li>';
  if (legacyChecked.length) {
    html += '<li><strong>舊版已清點：</strong>' + escapeHtml_(legacyChecked.join('、')) + '（未區分足夠或已叫貨）</li>';
  }
  // 正常提交不應包含以下狀態；保留防呆，避免舊資料或人工改值被誤認為正常完成。
  if (needsOrder.length) {
    html += '<li style="color:#9a3412;"><strong>資料異常・仍待叫貨：</strong>' + escapeHtml_(needsOrder.join('、')) + '</li>';
  }
  if (unconfirmed.length) {
    html += '<li style="color:#9a3412;"><strong>資料異常・未確認：</strong>' + escapeHtml_(unconfirmed.join('、')) + '</li>';
  }
  return html + '</ul>';
}

function checkWeeklyAdminReport() {
  runJob_('WEEKLY_ADMIN_REPORT', function () {
    const members = fetchCollection_('members');
    const dutyRecords = fetchCollection_('duty_records');
    const routines = fetchCollection_('routines');
    const logs = fetchCollection_('logs');
    const instruments = fetchCollection_('instruments');
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
    const logsHtml = buildLogsSummary_(logs, instruments, lastMonday, thisMonday);
    const accountingHtml = buildAccountingSummary_(accounting, members, lastMonday, thisMonday);

    const reportBody = '<p style="color:#526075;">報表期間：' + lastMonday + '～' + lastSunday + '</p>'
      + sectionHtml_('1. 值日生狀況', dutyHtml)
      + sectionHtml_('2. 實驗室行事', routineHtml)
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

/**
 * 正式上線前的唯讀檢查：不寄信、不修改 Firestore，也不重建觸發器。
 * 執行紀錄顯示 READY 才代表排程、網址、收件名單與寄信配額皆已就緒。
 */
function verifyLaunchReadiness() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const expectedHandlers = ['checkDutyReminder', 'checkDutyCompletionNotification', 'checkWeeklyAdminReport'];
  const installedHandlers = ScriptApp.getProjectTriggers().map(function (trigger) {
    return trigger.getHandlerFunction();
  });
  const missingHandlers = expectedHandlers.filter(function (handler) {
    return installedHandlers.indexOf(handler) === -1;
  });
  const duplicateHandlers = expectedHandlers.filter(function (handler) {
    return installedHandlers.filter(function (installed) { return installed === handler; }).length > 1;
  });
  const members = fetchCollection_('members');
  const dutyRoster = getDutyRoster_(members);
  const dutyRosterWithoutEmail = dutyRoster
    .filter(function (member) { return !isEmail_(member.Email); })
    .map(function (member) { return member.Student_ID; });
  const activeAdminEmails = members
    .filter(function (member) {
      return member.Role === 'Admin' && member.Status === 'Active' && isEmail_(member.Email);
    })
    .map(function (member) { return member.Email; });
  const siteUrl = (properties[PROPERTY_KEYS.siteUrl] || '').trim();
  const remainingQuota = MailApp.getRemainingDailyQuota();
  const problems = [];

  if (!properties[PROPERTY_KEYS.projectId]) problems.push('缺少 FIREBASE_PROJECT_ID');
  if (!/^https:\/\//i.test(siteUrl)) problems.push('GOODLAB_SITE_URL 尚未設定為 https 網址');
  if (missingHandlers.length) problems.push('缺少觸發器：' + missingHandlers.join(', '));
  if (duplicateHandlers.length) problems.push('觸發器重複：' + duplicateHandlers.join(', '));
  if (!activeAdminEmails.length) problems.push('沒有可收週報的 Active Admin Email');
  if (!dutyRoster.length) problems.push('目前沒有可輪值的 Active Master 成員');
  if (dutyRosterWithoutEmail.length) problems.push('值日名單缺少 Email：' + dutyRosterWithoutEmail.join(', '));
  if (remainingQuota < 10) problems.push('今日剩餘寄信配額不足 10 封');

  const report = {
    status: problems.length ? 'NOT_READY' : 'READY',
    siteUrl: siteUrl || null,
    remainingDailyQuota: remainingQuota,
    activeAdminRecipients: activeAdminEmails.length,
    dutyRosterMembers: dutyRoster.length,
    installedHandlers: installedHandlers,
    problems: problems
  };
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) throw new Error('尚未完成上線設定：' + problems.join('；'));
  return report;
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

function buildLogsSummary_(logs, instruments, rangeStart, rangeEnd) {
  const recent = logs
    .filter(function (log) {
      const date = String(log.Date_Reported || '').slice(0, 10);
      return date >= rangeStart && date < rangeEnd;
    })
    .sort(function (a, b) { return String(b.Date_Reported || '').localeCompare(String(a.Date_Reported || '')); });
  const unresolved = logs.filter(function (log) { return log.Status !== 'Closed'; });
  const instrumentNames = {};
  instruments.forEach(function (instrument) {
    const instrumentId = String(instrument.Instrument_ID || instrument._id || '').trim();
    if (instrumentId) instrumentNames[instrumentId] = instrument.Name || instrumentId;
  });

  return '<p>上週新增：<strong>' + recent.length + '</strong> 筆；目前未結案：<strong>' + unresolved.length + '</strong> 筆。</p>'
    + (recent.length ? limitedListHtml_(recent, function (log) {
      const instrumentId = String(log.Instrument_ID || '').trim();
      const instrumentName = instrumentNames[instrumentId] || instrumentId || '未指定儀器';
      const isClosed = log.Status === 'Closed';
      const statusLabel = isClosed ? '已結案' : '待處理';
      const statusStyle = isClosed
        ? 'color:#047857;background:#d1fae5;'
        : 'color:#b91c1c;background:#fee2e2;';
      const solutionHtml = isClosed && log.Solution
        ? '<br><span style="color:#526075;font-size:13px;">處理：'
          + escapeHtml_(truncate_(log.Solution, 80)) + '</span>'
        : '';

      return '<strong>' + escapeHtml_(instrumentName) + '</strong> '
        + '<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;font-weight:700;'
        + statusStyle + '">' + statusLabel + '</span>'
        + '<br><span>問題：' + escapeHtml_(truncate_(log.Problem_Desc || '未填描述', 80)) + '</span>'
        + solutionHtml;
    }) : '<p>上週沒有新增維修紀錄。</p>');
}

function buildAccountingSummary_(accounting, members, rangeStart, rangeEnd) {
  const recent = accounting
    .filter(function (item) {
      const date = String(item.Created_At || item.Date || '').slice(0, 10);
      return date >= rangeStart && date < rangeEnd;
    })
    .sort(function (a, b) {
      return String(b.Created_At || b.Date || '').localeCompare(String(a.Created_At || a.Date || ''));
    });

  const repayments = accounting
    .filter(function (item) {
      const date = String(item.Payback_Date || '').slice(0, 10);
      return item.Payer !== 'Fund'
        && (item.Type === 'School' || item.Type === 'Lab')
        && date >= rangeStart
        && date < rangeEnd;
    })
    .sort(function (a, b) {
      return String(b.Payback_Date || '').localeCompare(String(a.Payback_Date || ''));
    });
  const pending = accounting.filter(function (item) {
    return item.Payer !== 'Fund'
      && !item.Payback_Date
      && (item.Type === 'School' || item.Type === 'Lab');
  });
  const balances = calculateAccountingBalances_(accounting);
  const pendingAmount = pending.reduce(function (sum, item) {
    return sum + Math.abs(Number(item.Amount) || 0);
  }, 0);
  const repaymentAmount = repayments.reduce(function (sum, item) {
    return sum + Math.abs(Number(item.Amount) || 0);
  }, 0);
  const memberNames = {};
  members.forEach(function (member) {
    const name = member.Name_Ch || member.Student_ID;
    if (member.Student_ID) memberNames[String(member.Student_ID).toLowerCase()] = name;
    (member.Previous_Student_IDs || []).forEach(function (studentId) {
      memberNames[String(studentId).toLowerCase()] = name;
    });
  });
  const payerName = function (payerId) {
    return memberNames[String(payerId || '').toLowerCase()] || payerId || '未指定代墊人';
  };

  let html = '<p>上週新增：<strong>' + recent.length + '</strong> 筆；'
    + '完成還款：<strong>' + repayments.length + '</strong> 筆'
    + (repayments.length ? '，共 <strong>' + formatUnsignedMoney_(repaymentAmount) + '</strong>' : '')
    + '。</p>';

  if (recent.length) {
    html += '<h4 style="margin:14px 0 4px;">新增帳務</h4>'
      + limitedListHtml_(recent, function (item) {
      const amount = Number(item.Amount) || 0;
      return escapeHtml_(String(item.Date || '').slice(0, 10) || '未填日期')
        + '｜' + escapeHtml_(item.Description || '未填項目')
        + '｜' + formatMoney_(amount);
      });
  }

  if (repayments.length) {
    html += '<h4 style="margin:14px 0 4px;">完成還款</h4>'
      + limitedListHtml_(repayments, function (item) {
        return escapeHtml_(String(item.Payback_Date || '').slice(0, 10))
          + '｜' + escapeHtml_(payerName(item.Payer))
          + '｜' + formatUnsignedMoney_(Math.abs(Number(item.Amount) || 0))
          + '（' + paybackMethodLabel_(item) + '）';
      });
  }

  html += '<div style="margin-top:14px;padding:12px 14px;border:1px solid #dce3ec;border-radius:8px;background:#f8fafc;">'
    + '<strong>目前帳務</strong><br>'
    + '戶頭：' + formatSignedBalance_(balances.bankBalance)
    + '｜現金：' + formatSignedBalance_(balances.cashBalance)
    + '｜合計：' + formatSignedBalance_(balances.totalBalance)
    + '<br>待還款：' + pending.length + ' 筆，共 ' + formatUnsignedMoney_(pendingAmount)
    + '</div>';
  return html;
}

function normalizeAccountingSource_(value) {
  return value === 'Cash' ? 'Cash' : 'Bank';
}

function accountingPaybackMethod_(item) {
  return normalizeAccountingSource_(item.Payback_Method || item.Fund_Source);
}

function paybackMethodLabel_(item) {
  return accountingPaybackMethod_(item) === 'Cash' ? '現金' : '戶頭轉帳';
}

function calculateAccountingBalances_(accounting) {
  let bankBalance = 0;
  let cashBalance = 0;

  accounting.forEach(function (item) {
    const amount = Math.abs(Number(item.Amount) || 0);
    const type = item.Type;
    const isFund = item.Payer === 'Fund';
    const isPaidBack = Boolean(item.Payback_Date);
    const fundSource = normalizeAccountingSource_(item.Fund_Source);

    if (type === 'Income' || type === 'Deposit') {
      if (fundSource === 'Cash') cashBalance += amount;
      else bankBalance += amount;
    } else if (type === 'Withdraw' || type === 'Withdrawal') {
      bankBalance -= amount;
      cashBalance += amount;
    } else if (type === 'School' || type === 'Lab') {
      if (isFund) {
        if (fundSource === 'Cash') cashBalance -= amount;
        else bankBalance -= amount;
      } else if (isPaidBack) {
        if (accountingPaybackMethod_(item) === 'Cash') cashBalance -= amount;
        else bankBalance -= amount;
      }
      if (type === 'School' && item.Recharge_Date) bankBalance += amount;
    }
  });

  return {
    bankBalance: bankBalance,
    cashBalance: cashBalance,
    totalBalance: bankBalance + cashBalance
  };
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
  const roster = getDutyRoster_(members);
  const nextAssignedTo = nextRecord && (nextRecord.assigned_to || nextRecord.scheduled_to);
  if (nextAssignedTo) {
    const explicitlyAssigned = roster.find(function (member) { return member.Student_ID === nextAssignedTo; });
    if (explicitlyAssigned) return explicitlyAssigned;
  }

  if (!roster.length) return null;

  const scheduledTo = record.scheduled_to || record.assigned_to;
  const currentIndex = roster.findIndex(function (member) { return member.Student_ID === scheduledTo; });
  if (currentIndex >= 0) return roster[(currentIndex + 1) % roster.length];
  return roster.find(function (member) {
    return String(member.Student_ID).localeCompare(
      String(scheduledTo || ''), 'en', { numeric: true, sensitivity: 'base' }
    ) > 0;
  }) || roster[0];
}

function isDutyRosterMember_(member) {
  return Boolean(member)
    && member.Degree === 'Master'
    && member.Role !== 'Admin'
    && member.Status === 'Active';
}

function getDutyRoster_(members) {
  return members
    .filter(isDutyRosterMember_)
    .sort(function (a, b) {
      const enrollmentDifference = dutyEnrollmentTime_(a) - dutyEnrollmentTime_(b);
      if (enrollmentDifference) return enrollmentDifference;
      return String(a.Student_ID).localeCompare(
        String(b.Student_ID), 'en', { numeric: true, sensitivity: 'base' }
      );
    });
}

function dutyEnrollmentTime_(member) {
  const value = member && member.Enrollment_Date;
  if (!value) return 8640000000000000;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : 8640000000000000;
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

function formatDutyDate_(dateKey) {
  const date = new Date(dateKey + 'T12:00:00+08:00');
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekdayIndex = Number(Utilities.formatDate(date, TIME_ZONE, 'u')) % 7;
  return Utilities.formatDate(date, TIME_ZONE, 'yyyy/M/d') + '（' + weekdays[weekdayIndex] + '）';
}

function formatDutyDateRangeShort_(startKey, endKey) {
  const start = new Date(startKey + 'T12:00:00+08:00');
  const end = new Date(endKey + 'T12:00:00+08:00');
  const startText = Utilities.formatDate(start, TIME_ZONE, 'yyyy/M/d');
  const endPattern = start.getFullYear() === end.getFullYear() ? 'M/d' : 'yyyy/M/d';
  return startText + '–' + Utilities.formatDate(end, TIME_ZONE, endPattern);
}

function formatDutySubmittedAt_(value) {
  if (!value) return '未記錄';
  const date = new Date(value);
  if (isNaN(date.getTime())) return escapeHtml_(value);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekdayIndex = Number(Utilities.formatDate(date, TIME_ZONE, 'u')) % 7;
  return Utilities.formatDate(date, TIME_ZONE, 'yyyy/M/d')
    + '（' + weekdays[weekdayIndex] + '） '
    + Utilities.formatDate(date, TIME_ZONE, 'HH:mm');
}

function formatMoney_(amount) {
  const rounded = Math.round(Number(amount) || 0);
  return (rounded >= 0 ? '+' : '-') + '$' + Math.abs(rounded).toLocaleString('zh-TW');
}

function formatUnsignedMoney_(amount) {
  return '$' + Math.abs(Math.round(Number(amount) || 0)).toLocaleString('zh-TW');
}

function formatSignedBalance_(amount) {
  const rounded = Math.round(Number(amount) || 0);
  return (rounded < 0 ? '-' : '') + '$' + Math.abs(rounded).toLocaleString('zh-TW');
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

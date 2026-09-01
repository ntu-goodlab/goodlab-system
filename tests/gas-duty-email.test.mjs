import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function formatDate(date, _timeZone, pattern) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(date).map(part => [part.type, part.value]));
    const isoWeekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[parts.weekday];
    const values = {
        'yyyy-MM-dd': `${parts.year}-${parts.month}-${parts.day}`,
        'yyyy/M/d': `${parts.year}/${Number(parts.month)}/${Number(parts.day)}`,
        'M/d': `${Number(parts.month)}/${Number(parts.day)}`,
        'HH:mm': `${parts.hour}:${parts.minute}`,
        u: String(isoWeekday)
    };
    return values[pattern];
}

function createGasContext() {
    const context = vm.createContext({
        console,
        Intl,
        Date,
        Number,
        String,
        Object,
        Array,
        Boolean,
        Math,
        JSON,
        isNaN,
        Utilities: { formatDate },
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key => key === 'GOODLAB_SITE_URL'
                    ? 'https://ntu-goodlab.github.io/goodlab-system/'
                    : ''
            })
        }
    });
    const source = fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');
    vm.runInContext(source, context);
    return context;
}

test('值日完成信顯示本週與下週區間、叫貨狀況及執行紀錄連結', () => {
    const context = createGasContext();
    const expression = `buildDutyCompletionMessage_(
      {
        _id: '2026-08-31', week_start: '2026-08-31',
        scheduled_to: 'r14k43050', assigned_to: 'r14k43050',
        submitted: true, submitted_at: '2026-08-31T10:33:26.415Z',
        supplies: {
          acetone: 'ordered', methanol: 'ordered', detergent: 'sufficient',
          n2_tank: true, wiper: true, glass_slide: true, gloves_s: true,
          gloves_m: true, gloves_l: true, cotton_swab: true, aluminum_foil: true, pe_gloves: true
        },
        note: '交接留言'
      },
      [
        { Student_ID: 'r14k43050', Name_Ch: '何品彥', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2024-09-01' },
        { Student_ID: 'r14941081', Name_Ch: '蔡蓁羚', Degree: 'Master', Role: 'User', Status: 'Active', Enrollment_Date: '2025-09-01' }
      ],
      [{ _id: '2026-09-07', scheduled_to: 'r14941081', assigned_to: 'r14941081', assignment_source: 'admin' }],
      'goodlab301@gmail.com', false, 'students@example.com'
    )`;
    const message = vm.runInContext(expression, context);

    assert.equal(message.subject, '【GOODLAB】2026/8/31–9/6 值日工作已完成');
    assert.match(message.htmlBody, /值日期間：<\/strong>2026\/8\/31（一）～2026\/9\/6（日）/);
    assert.match(message.htmlBody, /提交時間：<\/strong>2026\/8\/31（一） 18:33/);
    assert.match(message.htmlBody, /本週叫貨：<\/strong>Acetone、Methanol/);
    assert.doesNotMatch(message.htmlBody, /仍待叫貨/);
    assert.match(message.htmlBody, /值日生：<\/strong>蔡蓁羚/);
    assert.match(message.htmlBody, /2026\/9\/7（一）～2026\/9\/13（日）/);
    assert.match(message.htmlBody, /查看值日生執行紀錄/);
    assert.match(message.htmlBody, /#\/duty-history/);
});

test('所有耗材足夠時，完成信簡單顯示本週無需叫貨', () => {
    const context = createGasContext();
    const html = vm.runInContext(`buildDutySupplySummaryHtml_({
      acetone: 'sufficient', methanol: 'sufficient', detergent: 'sufficient',
      n2_tank: 'sufficient', wiper: 'sufficient', glass_slide: 'sufficient',
      gloves_s: 'sufficient', gloves_m: 'sufficient', gloves_l: 'sufficient',
      cotton_swab: 'sufficient', aluminum_foil: 'sufficient', pe_gloves: 'sufficient'
    })`, context);

    assert.match(html, /本週無需叫貨/);
    assert.doesNotMatch(html, /待叫貨|未確認/);
});

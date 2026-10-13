import * as U from './util.js';
import { esc, ymd, parseYmd } from './util.js';
import { calcShift, calcShifts, total, payPeriod } from './calc.js';
import * as S from './settings.js';
import * as G from './google.js';
import * as D from './data.js';

const $ = sel => document.querySelector(sel);
const view = $('#view');

const state = {
  month: U.startOfMonth(new Date()),
  selected: U.startOfDay(new Date()),
  shiftMonth: U.startOfMonth(new Date()),
  payMonth: U.startOfMonth(new Date()),
  patternId: S.settings.patterns[0]?.id || null,
  eraser: false,
  todoList: '',
};

// 画面に出ている予定・シフト・ToDo（クリック時に引くため）
let shown = { events: new Map(), shifts: new Map(), tasks: new Map() };

// ---------- 共通 ----------

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function setBanner() {
  const b = $('#banner');
  if (D.mode() === 'google' && !G.hasValidToken()) {
    b.innerHTML = `<span>Google との接続が切れました</span><button data-global="reconnect">再接続</button>`;
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

async function guard(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    if (err instanceof D.AuthError) { setBanner(); toast('Google の再接続が必要です'); }
    else toast('エラー: ' + err.message);
  }
}

function monthHead(month, action) {
  return `<div class="month-head">
    <button class="icon" data-action="${action}" data-step="-1" aria-label="前の月">‹</button>
    <h2>${month.getFullYear()}年 ${month.getMonth() + 1}月</h2>
    <button class="icon" data-action="${action}" data-step="1" aria-label="次の月">›</button>
  </div>`;
}

function monthGrid(month, cellFn, extraClass = '') {
  const ws = S.settings.weekStart;
  const head = U.orderedWeekdays(ws).map(w =>
    `<div class="wd ${w === '日' ? 'sun' : w === '土' ? 'sat' : ''}">${w}</div>`).join('');
  const cells = U.gridDays(month, ws).map(day => {
    const inMonth = U.sameMonth(day, month);
    return `<div class="cell ${inMonth ? '' : 'out'}" data-day="${ymd(day)}">${dayNum(day)}${cellFn(day)}</div>`;
  }).join('');
  return `<div class="weekdays">${head}</div><div class="grid ${extraClass}" data-swipe>${cells}</div>`;
}

function dayNum(day) {
  const cls = [U.isToday(day) ? 'today' : '', day.getDay() === 0 ? 'sun' : day.getDay() === 6 ? 'sat' : ''].join(' ');
  return `<span class="num ${cls}">${day.getDate()}</span>`;
}

function shiftChip(s) {
  const wp = S.workplace(s.workplaceId);
  const name = S.pattern(s.patternId)?.name || s.title;
  return `<div class="chip" style="background:${U.colorHex(wp?.color)}">${esc(name)}</div>`;
}

const eventKey = e => e.calendarId + '|' + e.id + '|' + e.start.getTime();
const onDay = (day, list) => list.filter(e => e.start < U.addDays(day, 1) && (e.end > day || (+e.end === +e.start && U.sameDay(e.start, day))));
const shiftsOn = (day, list) => list.filter(s => U.sameDay(s.start, day));

// ---------- カレンダー ----------

async function renderCalendar() {
  const days = U.gridDays(state.month, S.settings.weekStart);
  const start = days[0], end = U.addDays(days[days.length - 1], 1);
  const [events, shifts, tasks] = await Promise.all([D.events(start, end), D.shifts(start, end), D.tasks().catch(() => [])]);
  shown = {
    events: new Map(events.map(e => [eventKey(e), e])),
    shifts: new Map(shifts.map(s => [s.id, s])),
    tasks: new Map(tasks.map(t => [t.id, t])),
  };

  const grid = monthGrid(state.month, day => {
    const ss = shiftsOn(day, shifts);
    const es = onDay(day, events);
    const hasTask = tasks.some(t => t.due === ymd(day));
    const limit = ss.length ? 2 : 3;
    return (hasTask ? '<span class="dot"></span>' : '') +
      ss.slice(0, 1).map(shiftChip).join('') +
      es.slice(0, limit).map(e => `<div class="ev" style="--c:${e.color}">${esc(e.title)}</div>`).join('') +
      (es.length > limit ? `<div class="more">+${es.length - limit}</div>` : '');
  });

  const sel = state.selected;
  const dayShifts = shiftsOn(sel, shifts);
  const dayEvents = onDay(sel, events);
  const dayTasks = tasks.filter(t => t.due === ymd(sel));
  const rows = [
    ...dayShifts.map(s => {
      const r = calcShift(s);
      const wp = S.workplace(s.workplaceId);
      return row(U.colorHex(wp?.color), `${U.hm(s.start)}<br>${U.hm(s.end)}`, '💼 ' + s.title,
        `休憩${s.breakMinutes}分・${U.hours(r.workMinutes)}・${U.yen(total(r))}`, `data-action="edit-shift" data-id="${esc(s.id)}"`);
    }),
    ...dayEvents.map(e => row(e.color, e.allDay ? '終日' : `${U.hm(e.start)}<br>${U.hm(e.end)}`, e.title,
      [e.location, e.calendarName].filter(Boolean).join('・'), `data-action="edit-event" data-key="${esc(eventKey(e))}"`)),
    ...dayTasks.map(taskRow),
  ];

  view.innerHTML = `
    ${monthHead(state.month, 'month')}
    ${grid.replace(`data-day="${ymd(sel)}"`, `data-day="${ymd(sel)}" data-selected`)}
    <section class="day">
      <div class="day-head">
        <h3>${sel.getMonth() + 1}月${sel.getDate()}日（${U.WEEKDAYS[sel.getDay()]}）</h3>
        <button class="pill" data-action="new-event">＋ 予定</button>
        <button class="pill" data-action="new-task">＋ ToDo</button>
      </div>
      ${rows.length ? rows.join('') : '<p class="empty">予定はありません</p>'}
    </section>`;
}

function row(color, time, title, sub, attrs) {
  return `<button class="row" ${attrs}>
    <span class="time">${time}</span><span class="bar" style="background:${color}"></span>
    <span class="body"><span class="title">${esc(title)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
  </button>`;
}

function taskRow(t) {
  const overdue = t.due && parseYmd(t.due) < U.startOfDay(new Date());
  const meta = [t.due ? U.mdw(parseYmd(t.due)) : null, D.mode() === 'google' && !state.todoList ? t.listName : null].filter(Boolean).join('・');
  return `<div class="task" data-id="${esc(t.id)}">
    <button class="check" data-action="toggle-task" data-id="${esc(t.id)}" aria-label="完了"></button>
    <span class="body"><span class="title">${esc(t.title)}</span>${meta ? `<span class="sub ${overdue ? 'red' : ''}">${esc(meta)}</span>` : ''}</span>
    <button class="icon del" data-action="delete-task" data-id="${esc(t.id)}" aria-label="削除">✕</button>
  </div>`;
}

// ---------- シフト入力 ----------

async function renderShift() {
  const days = U.gridDays(state.shiftMonth, S.settings.weekStart);
  const shifts = await D.shifts(days[0], U.addDays(days[days.length - 1], 1));
  shown.shifts = new Map(shifts.map(s => [s.id, s]));
  const monthShifts = shifts.filter(s => U.sameMonth(s.start, state.shiftMonth));
  const sum = calcShifts(monthShifts);

  const palette = S.settings.patterns.map(p => {
    const wp = S.workplace(p.workplaceId);
    const on = !state.eraser && state.patternId === p.id;
    return `<button class="pattern ${on ? 'on' : ''}" style="--c:${U.colorHex(wp?.color)}" data-action="pick" data-id="${p.id}">
      <b>${esc(p.name)}</b><small>${U.minutesText(p.start)}-${U.minutesText(p.end)}</small></button>`;
  }).join('') + `<button class="pattern eraser ${state.eraser ? 'on' : ''}" data-action="eraser"><b>⌫ 消す</b></button>`;

  const hint = !S.settings.patterns.length ? '「設定」でシフトのパターンを登録してください。'
    : state.eraser ? '日付をタップするとシフトを消します。'
    : 'パターンを選んで日付をタップで登録。同じパターンをもう一度タップで取り消し。長押し（PC は右クリック）で編集。';

  view.innerHTML = `
    <div class="palette">${palette}</div>
    ${monthHead(state.shiftMonth, 'shift-month')}
    ${monthGrid(state.shiftMonth, day => shiftsOn(day, shifts).map(shiftChip).join(''), 'shift-grid')}
    <div class="stats">
      ${stat('勤務', monthShifts.length + '日')}${stat('時間', U.hours(sum.workMinutes))}${stat('見込み（暦月）', U.yen(total(sum)))}
    </div>
    <p class="hint">${hint}</p>`;
}

const stat = (t, v) => `<div class="stat"><small>${t}</small><b>${v}</b></div>`;

async function tapShiftDay(day) {
  const existing = shiftsOn(day, [...shown.shifts.values()]);
  if (state.eraser) {
    for (const s of existing) await D.deleteShift(s.id);
    return render();
  }
  const p = S.pattern(state.patternId);
  const wp = p && S.workplace(p.workplaceId);
  if (!p || !wp) return toast('パターンを選んでください');
  const same = existing.find(s => s.patternId === p.id);
  if (same) await D.deleteShift(same.id);
  else await D.saveShift(D.shiftFromPattern(p, wp, day));
  render();
}

// ---------- 給料 ----------

async function renderPay() {
  const m = state.payMonth;
  const y = m.getFullYear();
  const yearShifts = await D.shifts(new Date(y, 0, 1), new Date(y + 1, 0, 1));
  const yr = calcShifts(yearShifts);
  const known = new Set(S.settings.workplaces.map(w => w.id));

  const sections = await Promise.all(S.settings.workplaces.map(async wp => {
    const period = payPeriod(y, m.getMonth(), wp.closingDay);
    const list = (await D.shifts(period.start, period.end)).filter(s => s.workplaceId === wp.id);
    const r = calcShifts(list);
    const last = U.addDays(period.end, -1);
    const payMonth = new Date(last.getFullYear(), last.getMonth() + 1, 1).getMonth() + 1;
    return `<section class="card">
      <div class="card-head"><span class="dotc" style="background:${U.colorHex(wp.color)}"></span><b>${esc(wp.name)}</b><span class="big">${U.yen(total(r))}</span></div>
      <p class="sub">${U.md(period.start)}〜${U.md(last)}・給料日 ${payMonth}月${wp.payday ? wp.payday + '日' : '末日'}</p>
      <div class="stats">${stat('勤務', list.length + '日')}${stat('時間', U.hours(r.workMinutes))}${stat('深夜', U.hours(r.nightMinutes))}</div>
      <div class="stats">${stat('給与', U.yen(r.wage))}${stat('交通費', U.yen(r.transport))}</div>
      <details><summary>シフト一覧（${list.length}件）</summary>${list.map(payRow).join('')}</details>
    </section>`;
  }));

  const others = (await D.shifts(m, U.addMonths(m, 1))).filter(s => !known.has(s.workplaceId));
  const limit = S.settings.annualLimit;
  const ratio = limit ? Math.min(1, yr.wage / limit) : 0;

  view.innerHTML = `
    ${monthHead(m, 'pay-month')}
    ${sections.join('') || '<p class="empty">「設定」で勤務先を登録してください。</p>'}
    ${others.length ? `<section class="card"><h3>勤務先が未登録のシフト（暦月）</h3>${others.map(payRow).join('')}</section>` : ''}
    <section class="card">
      <h3>${y}年の累計（勤務日ベース）</h3>
      ${kv('勤務日数', yearShifts.length + '日')}${kv('勤務時間', U.hours(yr.workMinutes))}
      ${kv('給与（交通費除く）', U.yen(yr.wage))}${kv('交通費', U.yen(yr.transport))}
      ${limit ? `<div class="limit"><div class="kv"><span>年収ライン ${U.yen(limit)}</span><span class="${yr.wage >= limit ? 'red' : 'sub'}">あと ${U.yen(Math.max(0, limit - yr.wage))}</span></div>
        <div class="meter"><span style="width:${ratio * 100}%;background:${ratio > 0.9 ? 'var(--red)' : 'var(--accent)'}"></span></div></div>` : ''}
    </section>`;
}

const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
function payRow(s) {
  return `<div class="kv"><span>${U.mdw(s.start)} <small class="sub">${U.hm(s.start)}-${U.hm(s.end)}</small></span><span>${U.yen(total(calcShift(s)))}</span></div>`;
}

// ---------- ToDo ----------

async function renderTodo() {
  const [lists, all] = await Promise.all([D.taskLists(), D.tasks()]);
  shown.tasks = new Map(all.map(t => [t.id, t]));
  const items = all.filter(t => !state.todoList || t.listId === state.todoList);
  const today = ymd(new Date());
  const groups = [
    ['期限切れ', items.filter(t => t.due && t.due < today), 'red'],
    ['今日', items.filter(t => t.due === today), 'accent'],
    ['予定', items.filter(t => t.due && t.due > today), ''],
    ['期限なし', items.filter(t => !t.due), ''],
  ];
  view.innerHTML = `
    <div class="todo-top">
      <select data-change="todo-list">
        <option value="">すべてのリスト</option>
        ${lists.map(l => `<option value="${esc(l.id)}" ${state.todoList === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>
      <button class="pill" data-action="new-task">＋ 期限つきで追加</button>
    </div>
    <form class="quick" data-submit="quick-task"><input name="title" placeholder="ToDo をすばやく追加（期限なし）" autocomplete="off"><button>追加</button></form>
    ${groups.filter(g => g[1].length).map(([title, list, cls]) =>
      `<h4 class="${cls}">${title}（${list.length}）</h4>${list.map(taskRow).join('')}`).join('')}
    ${items.length ? '' : '<p class="empty">未完了の ToDo はありません 🎉</p>'}
    ${D.mode() === 'google' ? '<p class="hint">Google ToDo リストと同期しています（期限は日付のみ）。</p>' : ''}`;
}

// ---------- 設定 ----------

async function renderSettings() {
  const s = S.settings;
  const google = D.mode() === 'google';
  let calRows = '';
  if (google && G.hasValidToken()) {
    const cals = await D.calendars();
    calRows = cals.map(c => `<label class="kv"><span><span class="dotc" style="background:${c.color}"></span>${esc(c.name)}</span>
      <input type="checkbox" data-change="cal-visible" value="${esc(c.id)}" ${s.hiddenCalendars.includes(c.id) ? '' : 'checked'}></label>`).join('');
  }

  view.innerHTML = `
    <section class="card">
      <h3>Google 連携</h3>
      <p class="sub">${google ? (G.hasValidToken() ? '✅ 接続中：Google カレンダー・ToDo リストと同期しています' : '⚠️ 接続が切れています')
        : '📱 端末内モード：データはこのブラウザだけに保存されます'}</p>
      <label class="field"><span>クライアント ID</span><input data-change="client-id" value="${esc(G.clientId())}" placeholder="xxxx.apps.googleusercontent.com"></label>
      <div class="buttons">
        ${google ? `<button class="pill" data-action="reconnect">再接続</button><button class="pill danger" data-action="disconnect">切断</button>`
          : `<button class="pill primary" data-action="connect">Google に接続</button>`}
      </div>
      <details><summary>接続の準備（最初の1回だけ）</summary>
        <ol class="guide">
          <li><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> でプロジェクトを作成</li>
          <li>「API とサービス」→「ライブラリ」で <b>Google Calendar API</b>・<b>Google Tasks API</b>・<b>Google Drive API</b> を有効化</li>
          <li>「OAuth 同意画面」で外部・テスト中のまま作成し、テストユーザーに自分の Gmail を追加</li>
          <li>「認証情報」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」</li>
          <li>「承認済みの JavaScript 生成元」と「承認済みのリダイレクト URI」に次を追加：<br><code>${esc(location.origin)}</code><br><code>${esc(G.redirectUri())}</code></li>
          <li>表示されたクライアント ID を上の欄に貼り付けて「Google に接続」</li>
        </ol>
        <p class="sub">「このアプリは Google で確認されていません」と出たら「詳細」→「（安全ではないページ）に移動」で進めます。自分専用のアプリなので問題ありません。</p>
      </details>
    </section>

    <section class="card">
      <h3>勤務先</h3>
      ${s.workplaces.map(w => `<button class="row" data-action="edit-wp" data-id="${w.id}">
        <span class="dotc" style="background:${U.colorHex(w.color)}"></span><span class="body"><span class="title">${esc(w.name)}</span></span>
        <span class="sub">時給 ${U.yen(w.wage)}</span></button>`).join('')}
      <button class="pill" data-action="new-wp">＋ 勤務先を追加</button>
    </section>

    <section class="card">
      <h3>シフトのパターン</h3>
      ${s.patterns.map(p => `<button class="row" data-action="edit-pattern" data-id="${p.id}">
        <span class="dotc" style="background:${U.colorHex(S.workplace(p.workplaceId)?.color)}"></span><span class="body"><span class="title">${esc(p.name)}</span></span>
        <span class="sub">${U.minutesText(p.start)}-${U.minutesText(p.end)}</span></button>`).join('')}
      <button class="pill" data-action="new-pattern" ${s.workplaces.length ? '' : 'disabled'}>＋ パターンを追加</button>
    </section>

    <section class="card">
      <h3>表示</h3>
      <label class="kv"><span>週の始まり</span><select data-change="week-start">
        <option value="0" ${s.weekStart === 0 ? 'selected' : ''}>日曜日</option>
        <option value="1" ${s.weekStart === 1 ? 'selected' : ''}>月曜日</option></select></label>
      <label class="kv"><span>年収ライン（0 = 表示しない）</span><span><input type="number" inputmode="numeric" class="num-in" data-change="annual-limit" value="${s.annualLimit}"> 円</span></label>
    </section>

    ${calRows ? `<section class="card"><h3>表示するカレンダー</h3>${calRows}</section>` : ''}

    ${google ? '' : `<section class="card">
      <h3>バックアップ</h3>
      <p class="sub">端末内モードのデータを書き出し／読み込みできます。</p>
      <div class="buttons"><button class="pill" data-action="export">書き出す</button>
      <label class="pill">読み込む<input type="file" accept="application/json" data-change="import" hidden></label></div>
    </section>`}
    <p class="hint center">All In Calendar Web v0.1</p>`;
}

// ---------- シート（編集画面） ----------

const sheet = $('#sheet');

function openSheet(title, bodyHtml, onSave, { saveLabel = '保存', onDelete = null, deleteLabel = '削除' } = {}) {
  sheet.innerHTML = `<form class="sheet-form">
    <header><button type="button" class="link" data-sheet="cancel">キャンセル</button><b>${title}</b>
      <button type="submit" class="link strong">${saveLabel}</button></header>
    <div class="sheet-body">${bodyHtml}
      ${onDelete ? `<button type="button" class="pill danger wide" data-sheet="delete">${deleteLabel}</button>` : ''}</div>
  </form>`;
  const form = sheet.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await guard(async () => {
      if ((await onSave(new FormData(form), form)) !== false) { sheet.close(); render(); }
    });
  });
  form.addEventListener('click', async e => {
    const a = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (a === 'cancel') sheet.close();
    if (a === 'delete' && confirm(deleteLabel + 'しますか？')) {
      await guard(async () => { await onDelete(); sheet.close(); render(); });
    }
  });
  sheet.showModal();
  return form;
}

const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
const options = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('');

async function openEventEditor(ev, day) {
  const cals = (await D.calendars()).filter(c => c.writable);
  const primary = cals.find(c => c.primary) || cals[0];
  let start, end;
  if (ev) {
    start = ev.start;
    end = ev.allDay ? U.addDays(ev.end, -1) : ev.end;
  } else {
    start = new Date(day);
    start.setHours(Math.min(new Date().getHours() + 1, 23), 0, 0, 0);
    end = new Date(start.getTime() + 3600000);
  }
  const reminders = [[-1, 'なし'], [0, '予定の時刻'], [10, '10分前'], [30, '30分前'], [60, '1時間前'], [1440, '1日前']];
  if (ev?.reminder === 'default') reminders.unshift(['default', 'カレンダーの既定']);
  const form = openSheet(ev ? '予定を編集' : '新しい予定', `
    ${field('タイトル', `<input name="title" required value="${esc(ev?.title === '(タイトルなし)' ? '' : ev?.title)}">`)}
    ${field('場所', `<input name="location" value="${esc(ev?.location)}">`)}
    <label class="kv"><span>終日</span><input type="checkbox" name="allDay" ${ev?.allDay ? 'checked' : ''}></label>
    <div class="two">${field('開始日', `<input type="date" name="startDate" value="${ymd(start)}" required>`)}
      ${field('時刻', `<input type="time" name="startTime" value="${U.hmInput(start)}" class="timed">`)}</div>
    <div class="two">${field('終了日', `<input type="date" name="endDate" value="${ymd(end)}" required>`)}
      ${field('時刻', `<input type="time" name="endTime" value="${U.hmInput(end)}" class="timed">`)}</div>
    ${ev ? (ev.recurring ? '<p class="sub">繰り返しの予定です。変更・削除はこの回だけに反映されます。</p>' : '')
      : field('繰り返し', `<select name="recurrence">${options([['none', 'しない'], ['daily', '毎日'], ['weekly', '毎週'], ['monthly', '毎月'], ['yearly', '毎年']], 'none')}</select>`)}
    ${field('通知', `<select name="reminder">${options(reminders, ev ? ev.reminder : -1)}</select>`)}
    ${field('カレンダー', `<select name="calendarId">${options(cals.map(c => [c.id, c.name]), ev?.calendarId || primary?.id)}</select>`)}
    ${field('メモ', `<textarea name="notes" rows="3">${esc(ev?.notes)}</textarea>`)}
  `, async fd => {
    const allDay = fd.get('allDay') === 'on';
    const s = allDay ? parseYmd(fd.get('startDate')) : U.combine(fd.get('startDate'), fd.get('startTime'));
    const e = allDay ? parseYmd(fd.get('endDate')) : U.combine(fd.get('endDate'), fd.get('endTime'));
    if (e < s) { toast('終了が開始より前になっています'); return false; }
    const r = fd.get('reminder');
    await D.saveEvent({
      id: ev?.id, originalCalendarId: ev?.calendarId, calendarId: fd.get('calendarId'),
      title: fd.get('title').trim(), allDay, start: s, end: e,
      location: fd.get('location').trim(), notes: fd.get('notes'),
      recurrence: fd.get('recurrence') || 'none', reminder: r === 'default' ? 'default' : Number(r),
    });
    toast('保存しました');
  }, { onDelete: ev ? () => D.deleteEvent(ev) : null, deleteLabel: '予定を削除' });

  // 終日なら時刻欄を隠す
  const sync = () => form.querySelectorAll('.timed').forEach(i => { i.closest('.field').style.visibility = form.elements.allDay.checked ? 'hidden' : ''; });
  form.elements.allDay.addEventListener('change', sync);
  sync();
  // 開始日を変えたら終了日も同じだけずらす
  let prevStart = form.elements.startDate.value;
  form.elements.startDate.addEventListener('change', () => {
    const diff = (parseYmd(form.elements.startDate.value) - parseYmd(prevStart)) / 86400000;
    if (form.elements.endDate.value) form.elements.endDate.value = ymd(U.addDays(parseYmd(form.elements.endDate.value), Math.round(diff)));
    prevStart = form.elements.startDate.value;
  });
}

function openShiftEditor(s) {
  const preview = form => {
    const fd = new FormData(form);
    const st = U.combine(fd.get('date'), fd.get('start'));
    let en = U.combine(fd.get('date'), fd.get('end'));
    if (en <= st) en = U.addDays(en, 1);
    const r = calcShift({ start: st, end: en, breakMinutes: Number(fd.get('brk')), wage: Number(fd.get('wage')), nightRate: s.nightRate, fee: s.fee });
    form.querySelector('.calc').innerHTML = kv('勤務時間', U.hours(r.workMinutes)) + kv('うち深夜', U.hours(r.nightMinutes)) +
      kv('交通費', U.yen(r.transport)) + kv('合計', `<b>${U.yen(total(r))}</b>`);
    return { st, en };
  };
  const form = openSheet('シフトを編集', `
    ${field('名前', `<input name="title" value="${esc(s.title)}" required>`)}
    ${field('日付', `<input type="date" name="date" value="${ymd(s.start)}" required>`)}
    <div class="two">${field('開始', `<input type="time" name="start" value="${U.hmInput(s.start)}">`)}
      ${field('終了', `<input type="time" name="end" value="${U.hmInput(s.end)}">`)}</div>
    <div class="two">${field('休憩（分）', `<input type="number" inputmode="numeric" name="brk" value="${s.breakMinutes}" min="0" step="5">`)}
      ${field('時給（円）', `<input type="number" inputmode="numeric" name="wage" value="${s.wage}" min="0">`)}</div>
    <div class="calc"></div>
  `, async (fd, f) => {
    const { st, en } = preview(f);
    await D.saveShift({ ...s, title: fd.get('title').trim(), start: st, end: en, breakMinutes: Number(fd.get('brk')), wage: Number(fd.get('wage')) });
    toast('保存しました');
  }, { onDelete: () => D.deleteShift(s.id), deleteLabel: 'シフトを削除' });
  form.addEventListener('input', () => preview(form));
  preview(form);
}

function openTaskEditor(day) {
  D.taskLists().then(lists => {
    openSheet('新しい ToDo', `
      ${field('タイトル', '<input name="title" required>')}
      ${field('メモ', '<textarea name="notes" rows="2"></textarea>')}
      ${field('期限', `<input type="date" name="due" value="${day ? ymd(day) : ''}">`)}
      ${lists.length > 1 ? field('リスト', `<select name="listId">${options(lists.map(l => [l.id, l.name]), state.todoList || lists[0].id)}</select>`) : ''}
    `, async fd => {
      await D.addTask({ title: fd.get('title').trim(), notes: fd.get('notes'), due: fd.get('due') || null, listId: fd.get('listId') });
      toast('追加しました');
    }, { saveLabel: '追加' });
  }).catch(err => guard(() => { throw err; }));
}

function openWorkplaceEditor(wp) {
  const isNew = !wp;
  wp = wp || { id: U.uuid(), name: '', color: 'blue', wage: 1200, nightRate: 1.25, fee: 0, closingDay: 0, payday: 25 };
  const days = [[0, '月末'], ...Array.from({ length: 28 }, (_, i) => [i + 1, `${i + 1}日`])];
  openSheet(isNew ? '勤務先を追加' : '勤務先を編集', `
    ${field('名前', `<input name="name" value="${esc(wp.name)}" required>`)}
    ${field('色', `<select name="color">${options(Object.entries(U.COLORS).map(([k, v]) => [k, v.label]), wp.color)}</select>`)}
    <div class="two">${field('時給（円）', `<input type="number" inputmode="numeric" name="wage" value="${wp.wage}" min="0">`)}
      ${field('交通費（1勤務）', `<input type="number" inputmode="numeric" name="fee" value="${wp.fee}" min="0">`)}</div>
    ${field('深夜割増（22〜5時）', `<select name="nightRate">${options([[1, 'なし'], [1.25, '25%'], [1.3, '30%'], [1.5, '50%']], wp.nightRate)}</select>`)}
    <div class="two">${field('締め日', `<select name="closingDay">${options(days, wp.closingDay)}</select>`)}
      ${field('給料日（翌月）', `<select name="payday">${options(days, wp.payday)}</select>`)}</div>
    <p class="sub">時給を変えても、登録済みのシフトの給料は変わりません（登録時の時給で計算）。</p>
  `, fd => {
    const v = {
      ...wp, name: fd.get('name').trim(), color: fd.get('color'), wage: Number(fd.get('wage')), fee: Number(fd.get('fee')),
      nightRate: Number(fd.get('nightRate')), closingDay: Number(fd.get('closingDay')), payday: Number(fd.get('payday')),
    };
    S.update(s => {
      const i = s.workplaces.findIndex(w => w.id === v.id);
      if (i >= 0) s.workplaces[i] = v; else s.workplaces.push(v);
    });
  }, {
    onDelete: isNew ? null : () => S.update(s => {
      s.workplaces = s.workplaces.filter(w => w.id !== wp.id);
      s.patterns = s.patterns.filter(p => p.workplaceId !== wp.id);
    }),
    deleteLabel: '勤務先とそのパターンを削除',
  });
}

function openPatternEditor(p) {
  const isNew = !p;
  p = p || { id: U.uuid(), name: '', workplaceId: S.settings.workplaces[0].id, start: 540, end: 1080, breakMinutes: 60 };
  const toInput = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const toMin = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  openSheet(isNew ? 'パターンを追加' : 'パターンを編集', `
    ${field('名前（例: 早番）', `<input name="name" value="${esc(p.name)}" required>`)}
    ${field('勤務先', `<select name="workplaceId">${options(S.settings.workplaces.map(w => [w.id, w.name]), p.workplaceId)}</select>`)}
    <div class="two">${field('開始', `<input type="time" name="start" value="${toInput(p.start)}" required>`)}
      ${field('終了', `<input type="time" name="end" value="${toInput(p.end)}" required>`)}</div>
    ${field('休憩（分）', `<input type="number" inputmode="numeric" name="brk" value="${p.breakMinutes}" min="0" step="5">`)}
    <p class="sub">終了が開始より前なら、翌日までの勤務として登録します。</p>
  `, fd => {
    const v = { ...p, name: fd.get('name').trim(), workplaceId: fd.get('workplaceId'), start: toMin(fd.get('start')), end: toMin(fd.get('end')), breakMinutes: Number(fd.get('brk')) };
    S.update(s => {
      const i = s.patterns.findIndex(x => x.id === v.id);
      if (i >= 0) s.patterns[i] = v; else s.patterns.push(v);
    });
    if (!state.patternId) state.patternId = v.id;
  }, { onDelete: isNew ? null : () => S.update(s => { s.patterns = s.patterns.filter(x => x.id !== p.id); }), deleteLabel: 'パターンを削除' });
}

// ---------- 画面の切り替え ----------

const TABS = {
  calendar: { title: 'All In Calendar', render: renderCalendar },
  shift: { title: 'シフト入力', render: renderShift },
  pay: { title: '給料', render: renderPay },
  todo: { title: 'ToDo', render: renderTodo },
  settings: { title: '設定', render: renderSettings },
};
const currentTab = () => (TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'calendar');

async function render() {
  const tab = currentTab();
  $('#title').textContent = TABS[tab].title;
  $('#today').hidden = tab !== 'calendar';
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  setBanner();
  if (D.mode() === 'google' && !G.hasValidToken() && tab !== 'settings') {
    view.innerHTML = `<div class="empty-state"><p>Google との接続が切れています。</p>
      <button class="pill primary" data-action="reconnect">Google に再接続</button>
      <p class="hint">アクセスの有効期限は約1時間です。</p></div>`;
    return;
  }
  if (!view.dataset.tab || view.dataset.tab !== tab) view.innerHTML = '<p class="empty">読み込み中…</p>';
  view.dataset.tab = tab;
  await guard(TABS[tab].render);
}

// ---------- 操作 ----------

const actions = {
  'month': b => { state.month = U.addMonths(state.month, +b.dataset.step); keepSelectionInMonth(); render(); },
  'shift-month': b => { state.shiftMonth = U.addMonths(state.shiftMonth, +b.dataset.step); render(); },
  'pay-month': b => { state.payMonth = U.addMonths(state.payMonth, +b.dataset.step); render(); },
  'new-event': () => guard(() => openEventEditor(null, state.selected)),
  'edit-event': b => {
    const ev = shown.events.get(b.dataset.key);
    if (!ev) return;
    if (!ev.writable) return toast('このカレンダーは編集できません');
    guard(() => openEventEditor(ev));
  },
  'edit-shift': b => { const s = shown.shifts.get(b.dataset.id); if (s) openShiftEditor(s); },
  'new-task': () => openTaskEditor(currentTab() === 'calendar' ? state.selected : null),
  'toggle-task': b => {
    const t = shown.tasks.get(b.dataset.id);
    if (!t) return;
    b.classList.add('done');
    b.closest('.task').classList.add('done');
    guard(async () => { await D.setTaskCompleted(t, true); setTimeout(render, 600); });
  },
  'delete-task': b => {
    const t = shown.tasks.get(b.dataset.id);
    if (t && confirm(`「${t.title}」を削除しますか？`)) guard(async () => { await D.deleteTask(t); render(); });
  },
  'pick': b => { state.patternId = b.dataset.id; state.eraser = false; render(); },
  'eraser': () => { state.eraser = !state.eraser; render(); },
  'new-wp': () => openWorkplaceEditor(null),
  'edit-wp': b => openWorkplaceEditor(S.workplace(b.dataset.id)),
  'new-pattern': () => openPatternEditor(null),
  'edit-pattern': b => openPatternEditor(S.pattern(b.dataset.id)),
  'connect': () => {
    if (!G.clientId()) return toast('先にクライアント ID を入力してください');
    G.signIn();
  },
  'reconnect': () => { if (!G.clientId()) { location.hash = '#settings'; return; } G.signIn(); },
  'disconnect': () => {
    if (!confirm('Google との接続を切りますか？（Google 側のデータは消えません）')) return;
    G.disconnect(); D.resetCaches(); render();
  },
  'export': () => {
    const blob = new Blob([D.exportLocal()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `allincalendar-${ymd(new Date())}.json`;
    a.click();
  },
};

function keepSelectionInMonth() {
  if (!U.sameMonth(state.selected, state.month)) {
    state.selected = U.sameMonth(new Date(), state.month) ? U.startOfDay(new Date()) : new Date(state.month);
  }
}

// 長押し（シフト編集）とクリックの判定
let pressTimer = null;
let longPressed = false;

function shiftLongPress(cell) {
  const day = parseYmd(cell.dataset.day);
  const list = shiftsOn(day, [...shown.shifts.values()]);
  if (list.length) openShiftEditor(list[0]);
}

view.addEventListener('pointerdown', e => {
  const cell = e.target.closest('.shift-grid .cell');
  longPressed = false;
  if (!cell) return;
  pressTimer = setTimeout(() => { longPressed = true; shiftLongPress(cell); }, 550);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => view.addEventListener(t, () => clearTimeout(pressTimer)));
view.addEventListener('contextmenu', e => {
  const cell = e.target.closest('.shift-grid .cell');
  if (!cell) return;
  e.preventDefault();
  clearTimeout(pressTimer);
  shiftLongPress(cell);
});

view.addEventListener('click', e => {
  if (longPressed) { longPressed = false; return; }
  const btn = e.target.closest('[data-action]');
  if (btn) return actions[btn.dataset.action]?.(btn);
  const cell = e.target.closest('.cell[data-day]');
  if (!cell) return;
  const day = parseYmd(cell.dataset.day);
  if (cell.closest('.shift-grid')) return guard(() => tapShiftDay(day));
  state.selected = day;
  if (!U.sameMonth(day, state.month)) state.month = U.startOfMonth(day);
  render();
});

view.addEventListener('change', e => {
  const k = e.target.dataset.change;
  if (!k) return;
  const v = e.target.value;
  if (k === 'todo-list') { state.todoList = v; render(); }
  if (k === 'week-start') { S.update(s => { s.weekStart = Number(v); }); render(); }
  if (k === 'annual-limit') S.update(s => { s.annualLimit = Math.max(0, Number(v) || 0); });
  if (k === 'client-id') { G.setClientId(v); toast('クライアント ID を保存しました'); render(); }
  if (k === 'cal-visible') {
    S.update(s => {
      s.hiddenCalendars = e.target.checked ? s.hiddenCalendars.filter(id => id !== v) : [...s.hiddenCalendars, v];
    });
    D.invalidate();
  }
  if (k === 'import') {
    const file = e.target.files[0];
    if (!file || !confirm('この端末のデータを、ファイルの内容で置き換えますか？')) return;
    file.text().then(t => { D.importLocal(t); toast('読み込みました'); render(); }).catch(err => toast('読み込めません: ' + err.message));
  }
});

view.addEventListener('submit', e => {
  if (e.target.dataset.submit !== 'quick-task') return;
  e.preventDefault();
  const title = e.target.elements.title.value.trim();
  if (!title) return;
  guard(async () => {
    await D.addTask({ title, due: null, listId: state.todoList || undefined });
    render();
  });
});

// 月の横スワイプ
let touchX = null, touchY = null;
view.addEventListener('touchstart', e => {
  if (!e.target.closest('[data-swipe]')) return;
  touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });
view.addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const step = dx < 0 ? 1 : -1;
  const tab = currentTab();
  if (tab === 'calendar') { state.month = U.addMonths(state.month, step); keepSelectionInMonth(); }
  if (tab === 'shift') state.shiftMonth = U.addMonths(state.shiftMonth, step);
  render();
});

document.addEventListener('click', e => {
  const g = e.target.closest('[data-global]');
  if (g?.dataset.global === 'reconnect') actions.reconnect();
});

$('#today').addEventListener('click', () => {
  state.month = U.startOfMonth(new Date());
  state.selected = U.startOfDay(new Date());
  render();
});

$('#tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) location.hash = '#' + b.dataset.tab;
});

window.addEventListener('hashchange', render);

// アプリに戻ってきたら最新を取り直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !sheet.open) { D.invalidate(); render(); }
});

// ---------- 起動 ----------

async function start() {
  const r = G.handleRedirect();
  if (r?.error) toast('Google に接続できませんでした: ' + r.error);
  if (r?.ok) { D.resetCaches(); toast('Google に接続しました'); }
  await render();
  if (D.mode() === 'google' && G.hasValidToken()) {
    D.pullSettings().then(changed => { if (changed) { toast('ほかの端末の設定を取り込みました'); render(); } }).catch(() => {});
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();

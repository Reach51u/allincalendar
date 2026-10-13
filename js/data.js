// 予定・シフト・ToDo の読み書き。
// Google 接続中は Google カレンダー／Google ToDo リスト／Google ドライブ、未接続なら端末内（localStorage）。
import { api, isConnected, AuthError } from './google.js';
import { settings, update, replaceIfNewer, setSaveHook } from './settings.js';
import { uuid, ymd, parseYmd, addDays } from './util.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHIFT_CAL_NAME = 'All In シフト';
const LOCAL_CAL = { id: 'local', name: 'この端末', color: '#0a84ff', writable: true };

export const mode = () => (isConnected() ? 'google' : 'local');
export { AuthError };

// ---------- 端末内保存 ----------
const local = {
  get(key) { try { return JSON.parse(localStorage.getItem('aic.' + key) || '[]'); } catch { return []; } },
  set(key, v) { localStorage.setItem('aic.' + key, JSON.stringify(v)); },
};

// ---------- キャッシュ ----------
let calendarsCache = null;
let shiftCalId = localStorage.getItem('aic.shiftCalId');
const rangeCache = new Map();
export function invalidate() { rangeCache.clear(); }

// ---------- カレンダー一覧 ----------
export async function calendars() {
  if (mode() === 'local') return [LOCAL_CAL];
  if (!calendarsCache) {
    const res = await api(`${CAL}/users/me/calendarList?maxResults=250`);
    calendarsCache = res.items.map(c => ({
      id: c.id,
      name: c.summaryOverride || c.summary,
      color: c.backgroundColor,
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
      primary: !!c.primary,
    }));
  }
  return calendarsCache.filter(c => c.id !== shiftCalId && c.name !== SHIFT_CAL_NAME);
}

async function ensureShiftCalendar() {
  if (shiftCalId) return shiftCalId;
  await calendars();
  const found = calendarsCache.find(c => c.name === SHIFT_CAL_NAME);
  if (found) {
    shiftCalId = found.id;
  } else {
    const created = await api(`${CAL}/calendars`, {
      method: 'POST',
      body: { summary: SHIFT_CAL_NAME, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    shiftCalId = created.id;
    calendarsCache = null;
  }
  localStorage.setItem('aic.shiftCalId', shiftCalId);
  return shiftCalId;
}

export function shiftCalendarName() { return SHIFT_CAL_NAME; }

// ---------- 予定 ----------
function fromGoogleEvent(e, cal) {
  const allDay = !!e.start.date;
  return {
    id: e.id,
    calendarId: cal.id,
    calendarName: cal.name,
    color: cal.color,
    title: e.summary || '(タイトルなし)',
    allDay,
    start: allDay ? parseYmd(e.start.date) : new Date(e.start.dateTime),
    end: allDay ? parseYmd(e.end.date) : new Date(e.end.dateTime),
    location: e.location || '',
    notes: e.description || '',
    recurring: !!e.recurringEventId,
    reminder: e.reminders?.overrides?.[0]?.minutes ?? (e.reminders?.useDefault ? 'default' : -1),
    writable: cal.writable,
  };
}

async function googleEvents(calId, start, end) {
  const params = new URLSearchParams({
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
  });
  const res = await api(`${CAL}/calendars/${encodeURIComponent(calId)}/events?${params}`);
  return res.items.filter(e => e.status !== 'cancelled');
}

/** 範囲内の予定（シフトを除く） */
export async function events(start, end) {
  const key = 'ev' + start.getTime() + '-' + end.getTime();
  if (rangeCache.has(key)) return rangeCache.get(key);
  let list;
  if (mode() === 'local') {
    list = local.get('events')
      .map(e => ({ ...e, start: new Date(e.start), end: new Date(e.end), color: LOCAL_CAL.color, calendarName: LOCAL_CAL.name, writable: true }))
      .filter(e => e.start < end && e.end > start);
  } else {
    const cals = (await calendars()).filter(c => !settings.hiddenCalendars.includes(c.id));
    const results = await Promise.all(cals.map(async c => {
      try { return (await googleEvents(c.id, start, end)).map(e => fromGoogleEvent(e, c)); }
      catch (err) { if (err instanceof AuthError) throw err; return []; }
    }));
    list = results.flat();
  }
  list.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
  rangeCache.set(key, list);
  return list;
}

/**
 * ev: { id?, calendarId, title, allDay, start, end, location, notes, recurrence, reminder }
 * 終日の予定の end は「最終日」（その日を含む）で受け取り、保存時に翌日0時（含まない）に直す。
 */
export async function saveEvent(ev) {
  invalidate();
  if (mode() === 'local') {
    const all = local.get('events');
    const item = {
      id: ev.id || uuid(), calendarId: 'local', title: ev.title, allDay: ev.allDay,
      start: ev.start.toISOString(), end: (ev.allDay ? addDays(ev.end, 1) : ev.end).toISOString(),
      location: ev.location, notes: ev.notes,
      reminder: ev.reminder,
    };
    const i = all.findIndex(e => e.id === item.id);
    if (i >= 0) all[i] = item; else all.push(item);
    // 端末内モードの繰り返しは、1年分を個別の予定として作る
    if (!ev.id && ev.recurrence && ev.recurrence !== 'none') {
      const step = { daily: [1, 'd'], weekly: [7, 'd'], monthly: [1, 'm'], yearly: [12, 'm'] }[ev.recurrence];
      const count = { daily: 365, weekly: 52, monthly: 12, yearly: 5 }[ev.recurrence];
      for (let n = 1; n < count; n++) {
        const shiftDate = d => {
          const x = new Date(d);
          if (step[1] === 'd') x.setDate(x.getDate() + step[0] * n); else x.setMonth(x.getMonth() + step[0] * n);
          return x;
        };
        all.push({ ...item, id: uuid(), start: shiftDate(item.start).toISOString(), end: shiftDate(item.end).toISOString() });
      }
    }
    local.set('events', all);
    return;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    summary: ev.title,
    location: ev.location || undefined,
    description: ev.notes || undefined,
    start: ev.allDay ? { date: ymd(ev.start) } : { dateTime: ev.start.toISOString(), timeZone: tz },
    end: ev.allDay ? { date: ymd(addDays(ev.end, 1)) } : { dateTime: ev.end.toISOString(), timeZone: tz },
  };
  if (ev.reminder !== 'default') {
    body.reminders = ev.reminder >= 0
      ? { useDefault: false, overrides: [{ method: 'popup', minutes: Number(ev.reminder) }] }
      : { useDefault: false, overrides: [] };
  }
  if (!ev.id && ev.recurrence && ev.recurrence !== 'none') {
    body.recurrence = ['RRULE:FREQ=' + ev.recurrence.toUpperCase()];
  }
  const cal = encodeURIComponent(ev.calendarId);
  if (ev.id && ev.originalCalendarId && ev.originalCalendarId !== ev.calendarId) {
    await api(`${CAL}/calendars/${encodeURIComponent(ev.originalCalendarId)}/events/${ev.id}/move?destination=${cal}`, { method: 'POST' });
  }
  if (ev.id) await api(`${CAL}/calendars/${cal}/events/${ev.id}`, { method: 'PATCH', body });
  else await api(`${CAL}/calendars/${cal}/events`, { method: 'POST', body });
}

export async function deleteEvent(ev) {
  invalidate();
  if (mode() === 'local') {
    local.set('events', local.get('events').filter(e => e.id !== ev.id));
    return;
  }
  await api(`${CAL}/calendars/${encodeURIComponent(ev.calendarId)}/events/${ev.id}`, { method: 'DELETE' });
}

// ---------- シフト ----------
// Google ではシフト専用カレンダーの予定として保存し、時給などは「非公開の拡張プロパティ」に入れる

function shiftFromGoogle(e) {
  const p = e.extendedProperties?.private || {};
  return {
    id: e.id,
    title: e.summary || 'シフト',
    start: new Date(e.start.dateTime || e.start.date),
    end: new Date(e.end.dateTime || e.end.date),
    breakMinutes: Number(p.brk || 0),
    workplaceId: p.wp || null,
    patternId: p.pt || null,
    wage: Number(p.wage || 0),
    nightRate: Number(p.night || 1.25),
    fee: Number(p.fee || 0),
  };
}

function shiftToGoogle(s) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    summary: s.title,
    start: { dateTime: s.start.toISOString(), timeZone: tz },
    end: { dateTime: s.end.toISOString(), timeZone: tz },
    description: `休憩 ${s.breakMinutes}分 / All In Calendar で管理`,
    extendedProperties: {
      private: {
        aic: '1', brk: String(s.breakMinutes), wage: String(s.wage), night: String(s.nightRate), fee: String(s.fee),
        ...(s.workplaceId ? { wp: s.workplaceId } : {}), ...(s.patternId ? { pt: s.patternId } : {}),
      },
    },
  };
}

export async function shifts(start, end) {
  const key = 'sh' + start.getTime() + '-' + end.getTime();
  if (rangeCache.has(key)) return rangeCache.get(key);
  let list;
  if (mode() === 'local') {
    list = local.get('shifts')
      .map(s => ({ ...s, start: new Date(s.start), end: new Date(s.end) }))
      .filter(s => s.start < end && s.start >= start);
  } else {
    const id = await ensureShiftCalendar();
    list = (await googleEvents(id, start, end)).map(shiftFromGoogle).filter(s => s.start >= start);
  }
  list.sort((a, b) => a.start - b.start);
  rangeCache.set(key, list);
  return list;
}

/** パターンから、その日のシフトを作る */
export function shiftFromPattern(pattern, wp, day) {
  const start = new Date(day); start.setHours(0, pattern.start, 0, 0);
  const end = new Date(day); end.setHours(0, pattern.end, 0, 0);
  if (pattern.end <= pattern.start) end.setDate(end.getDate() + 1);
  return {
    title: `${pattern.name}（${wp.name}）`, start, end, breakMinutes: pattern.breakMinutes,
    workplaceId: wp.id, patternId: pattern.id, wage: wp.wage, nightRate: wp.nightRate, fee: wp.fee,
  };
}

export async function saveShift(s) {
  invalidate();
  if (mode() === 'local') {
    const all = local.get('shifts');
    const item = { ...s, id: s.id || uuid(), start: s.start.toISOString(), end: s.end.toISOString() };
    const i = all.findIndex(x => x.id === item.id);
    if (i >= 0) all[i] = item; else all.push(item);
    local.set('shifts', all);
    return;
  }
  const cal = encodeURIComponent(await ensureShiftCalendar());
  if (s.id) await api(`${CAL}/calendars/${cal}/events/${s.id}`, { method: 'PATCH', body: shiftToGoogle(s) });
  else await api(`${CAL}/calendars/${cal}/events`, { method: 'POST', body: shiftToGoogle(s) });
}

export async function deleteShift(id) {
  invalidate();
  if (mode() === 'local') {
    local.set('shifts', local.get('shifts').filter(s => s.id !== id));
    return;
  }
  const cal = encodeURIComponent(await ensureShiftCalendar());
  await api(`${CAL}/calendars/${cal}/events/${id}`, { method: 'DELETE' });
}

// ---------- ToDo ----------
let taskListsCache = null;

export async function taskLists() {
  if (mode() === 'local') return [{ id: 'local', name: 'この端末' }];
  if (!taskListsCache) {
    const res = await api(`${TASKS}/users/@me/lists?maxResults=100`);
    taskListsCache = (res.items || []).map(l => ({ id: l.id, name: l.title }));
  }
  return taskListsCache;
}

/** 未完了の ToDo。due は 'YYYY-MM-DD' か null */
export async function tasks() {
  if (rangeCache.has('tasks')) return rangeCache.get('tasks');
  let list;
  if (mode() === 'local') {
    list = local.get('tasks').filter(t => !t.completed);
  } else {
    const lists = await taskLists();
    const results = await Promise.all(lists.map(async l => {
      const res = await api(`${TASKS}/lists/${l.id}/tasks?showCompleted=false&showHidden=false&maxResults=100`);
      return (res.items || []).filter(t => t.title).map(t => ({
        id: t.id, listId: l.id, listName: l.name, title: t.title, notes: t.notes || '',
        due: t.due ? t.due.slice(0, 10) : null, completed: t.status === 'completed',
      }));
    }));
    list = results.flat();
  }
  list.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0));
  rangeCache.set('tasks', list);
  return list;
}

export async function addTask({ title, notes, due, listId }) {
  invalidate();
  if (mode() === 'local') {
    local.set('tasks', [...local.get('tasks'), { id: uuid(), listId: 'local', listName: 'この端末', title, notes, due, completed: false }]);
    return;
  }
  const id = listId || (await taskLists())[0]?.id;
  await api(`${TASKS}/lists/${id}/tasks`, {
    method: 'POST',
    body: { title, notes: notes || undefined, due: due ? due + 'T00:00:00.000Z' : undefined },
  });
}

export async function setTaskCompleted(task, done) {
  invalidate();
  if (mode() === 'local') {
    local.set('tasks', local.get('tasks').map(t => (t.id === task.id ? { ...t, completed: done } : t)));
    return;
  }
  await api(`${TASKS}/lists/${task.listId}/tasks/${task.id}`, {
    method: 'PATCH', body: { status: done ? 'completed' : 'needsAction' },
  });
}

export async function deleteTask(task) {
  invalidate();
  if (mode() === 'local') {
    local.set('tasks', local.get('tasks').filter(t => t.id !== task.id));
    return;
  }
  await api(`${TASKS}/lists/${task.listId}/tasks/${task.id}`, { method: 'DELETE' });
}

// ---------- 設定の同期（Google ドライブのアプリ専用領域） ----------
let settingsFileId = null;
let uploadTimer = null;

async function findSettingsFile() {
  if (settingsFileId) return settingsFileId;
  const q = encodeURIComponent("name='settings.json'");
  const res = await api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
  settingsFileId = res.files?.[0]?.id || null;
  return settingsFileId;
}

/** ドライブの設定が新しければ取り込む。なければアップロードする */
export async function pullSettings() {
  if (mode() !== 'google') return false;
  const id = await findSettingsFile();
  if (!id) { await pushSettings(); return false; }
  const remote = JSON.parse(await api(`${DRIVE}/files/${id}?alt=media`));
  const changed = replaceIfNewer(remote);
  if (!changed && remote.updatedAt < settings.updatedAt) await pushSettings();
  return changed;
}

async function pushSettings() {
  const content = JSON.stringify(settings);
  const id = await findSettingsFile();
  if (id) {
    await api(`${UPLOAD}/files/${id}?uploadType=media`, {
      method: 'PATCH', body: content, raw: true, headers: { 'Content-Type': 'application/json' },
    });
    return;
  }
  const boundary = 'aic' + Date.now();
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify({ name: 'settings.json', parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await api(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST', body, raw: true, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
  });
  settingsFileId = res.id;
}

setSaveHook(() => {
  if (mode() !== 'google') return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => pushSettings().catch(() => {}), 1500);
});

/** 接続を切り替えたときにキャッシュを捨てる */
export function resetCaches() {
  calendarsCache = null;
  taskListsCache = null;
  settingsFileId = null;
  invalidate();
}

// ---------- バックアップ（端末内モード） ----------
export function exportLocal() {
  return JSON.stringify({
    settings, events: local.get('events'), shifts: local.get('shifts'), tasks: local.get('tasks'),
  }, null, 2);
}

export function importLocal(json) {
  const d = JSON.parse(json);
  if (d.events) local.set('events', d.events);
  if (d.shifts) local.set('shifts', d.shifts);
  if (d.tasks) local.set('tasks', d.tasks);
  if (d.settings) update(s => Object.assign(s, d.settings));
  invalidate();
}

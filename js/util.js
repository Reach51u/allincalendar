// 日付・表示まわりの小物

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
export function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
export function isToday(d) { return sameDay(d, new Date()); }

/** 月表示に並べる日（前後の月を含めて週単位） weekStart: 0=日 1=月 */
export function gridDays(month, weekStart) {
  const first = startOfMonth(month);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((lead + days) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

export function orderedWeekdays(weekStart) {
  return [...WEEKDAYS.slice(weekStart), ...WEEKDAYS.slice(0, weekStart)];
}

const pad = n => String(n).padStart(2, '0');
export function hm(d) { return `${d.getHours()}:${pad(d.getMinutes())}`; }
export function md(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
export function mdw(d) { return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`; }
export function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function hmInput(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
export function combine(dateStr, timeStr) {
  const d = parseYmd(dateStr);
  const [h, m] = (timeStr || '0:0').split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}
export function minutesText(min) { return `${Math.floor(min / 60)}:${pad(min % 60)}`; }

export function yen(v) { return '¥' + Math.round(v).toLocaleString('ja-JP'); }
export function hours(min) { return `${Math.floor(min / 60)}時間${pad(min % 60)}分`; }

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** 選べる色 */
export const COLORS = {
  green: { label: 'グリーン', hex: '#34c759' },
  blue: { label: 'ブルー', hex: '#0a84ff' },
  orange: { label: 'オレンジ', hex: '#ff9500' },
  red: { label: 'レッド', hex: '#ff3b30' },
  pink: { label: 'ピンク', hex: '#ff2d55' },
  purple: { label: 'パープル', hex: '#af52de' },
  teal: { label: 'ティール', hex: '#30b0c7' },
  brown: { label: 'ブラウン', hex: '#a2845e' },
  gray: { label: 'グレー', hex: '#8e8e93' },
};
export function colorHex(name) { return (COLORS[name] || COLORS.gray).hex; }

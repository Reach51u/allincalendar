// アプリ設定（勤務先・シフトパターンなど）。localStorage に保存し、
// Google 接続中は Google ドライブのアプリ専用領域にも保存して端末間で同期する。
import { uuid } from './util.js';

const KEY = 'aic.settings';
const listeners = new Set();
let saveHook = null;

function sample() {
  const wp = { id: uuid(), name: 'バイト先', color: 'green', wage: 1200, nightRate: 1.25, fee: 0, closingDay: 0, payday: 25 };
  return {
    workplaces: [wp],
    patterns: [
      { id: uuid(), name: '早番', workplaceId: wp.id, start: 360, end: 870, breakMinutes: 60 },
      { id: uuid(), name: '中番', workplaceId: wp.id, start: 660, end: 1170, breakMinutes: 60 },
      { id: uuid(), name: '遅番', workplaceId: wp.id, start: 900, end: 1380, breakMinutes: 60 },
    ],
    weekStart: 0,
    hiddenCalendars: [],
    annualLimit: 0,
    updatedAt: Date.now(),
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...sample(), ...JSON.parse(raw) };
  } catch { /* 壊れていたら作り直す */ }
  const s = sample();
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export let settings = load();

/** 設定を変更して保存する。fn の中で settings を直接書き換える */
export function update(fn) {
  fn(settings);
  settings.updatedAt = Date.now();
  localStorage.setItem(KEY, JSON.stringify(settings));
  listeners.forEach(l => l());
  if (saveHook) saveHook(settings);
}

/** 別の端末から取ってきた設定で置き換える（新しいときだけ） */
export function replaceIfNewer(remote) {
  if (!remote || !(remote.updatedAt > settings.updatedAt)) return false;
  settings = { ...sample(), ...remote };
  localStorage.setItem(KEY, JSON.stringify(settings));
  listeners.forEach(l => l());
  return true;
}

export function onChange(fn) { listeners.add(fn); }
export function setSaveHook(fn) { saveHook = fn; }

export const workplace = id => settings.workplaces.find(w => w.id === id);
export const pattern = id => settings.patterns.find(p => p.id === id);

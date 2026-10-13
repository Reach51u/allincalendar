// Google ログイン（OAuth のリダイレクト方式）と API 呼び出し。
// サーバーを持たないので、アクセストークン（約1時間有効）だけを使う。

const CLIENT_KEY = 'aic.googleClientId';
const TOKEN_KEY = 'aic.googleToken';
const CONNECTED_KEY = 'aic.googleConnected';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.appdata',
];

export function clientId() { return localStorage.getItem(CLIENT_KEY) || ''; }
export function setClientId(id) { localStorage.setItem(CLIENT_KEY, id.trim()); }

/** Google モードを選んでいるか（トークン切れでも true） */
export function isConnected() { return localStorage.getItem(CONNECTED_KEY) === '1'; }

function token() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.expiresAt > Date.now() + 60000) return t.accessToken;
  } catch { /* なし */ }
  return null;
}

export function hasValidToken() { return !!token(); }

/** ホーム画面から開くと /index.html になるので、末尾をそろえる */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** Google のログイン画面へ移動する */
export function signIn() {
  const id = clientId();
  if (!id) throw new Error('クライアント ID が未設定です');
  const state = Math.random().toString(36).slice(2);
  localStorage.setItem('aic.oauthState', state);
  localStorage.setItem('aic.returnHash', location.hash.startsWith('#access_token') ? '' : location.hash);
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

/** ログインから戻ってきたときに URL のトークンを受け取る。戻り先の画面を返す */
export function handleRedirect() {
  const hash = location.hash;
  if (!hash.includes('access_token=') && !hash.includes('error=')) return null;
  const p = new URLSearchParams(hash.slice(1));
  const back = localStorage.getItem('aic.returnHash') || '#calendar';
  history.replaceState(null, '', location.pathname + back);
  if (p.get('error')) return { error: p.get('error'), back };
  if (p.get('state') !== localStorage.getItem('aic.oauthState')) return { error: 'state_mismatch', back };
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken: p.get('access_token'),
    expiresAt: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
  }));
  localStorage.setItem(CONNECTED_KEY, '1');
  return { ok: true, back };
}

export function disconnect() {
  const t = token();
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + t, { method: 'POST' }).catch(() => {});
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(CONNECTED_KEY);
}

export class AuthError extends Error {}

/** Google API を呼ぶ。トークン切れなら AuthError */
export async function api(url, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const t = token();
  if (!t) throw new AuthError('Google の再接続が必要です');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + t,
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body && !raw ? JSON.stringify(body) : body,
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new AuthError('Google の再接続が必要です');
  }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch { /* そのまま */ }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

// gdrive-auth.js — Google OAuth 2.0 (PKCE) for cross-device title sync.
//
// Public-client (installed-app) PKCE flow, done almost entirely in JS:
//   1. Build code_verifier/code_challenge (Web Crypto; plain fallback).
//   2. Open Google's consent page in the system browser (@capacitor/browser).
//   3. Capture the redirect to the reversed-client-id custom scheme via
//      @capacitor/app's appUrlOpen (a SEPARATE listener from the AnkiMobile
//      one in sendToAnkiConnect.js — different scheme, no collision).
//   4. Exchange code -> tokens at oauth2.googleapis.com/token (no client
//      secret; public client). Store in Preferences, refresh on demand.
//
// Scope: `drive.file` (app sees only files it creates -> NO Google "sensitive
// scope" verification) plus `openid email` so we can show the connected
// account. The redirect URI MUST be the reversed client id
// (com.googleusercontent.apps.<id>:/oauth2redirect), registered natively in
// iOS Info.plist CFBundleURLSchemes and an Android <intent-filter>.
//
// Client IDs are NOT hardcoded — set them once via setConfig() (persisted to
// Preferences) so they can change without a rebuild. The native scheme still
// must match the client id at build time.

(function () {
  'use strict';

  const CONFIG_KEY = 'GDRIVE_CONFIG_V1';   // { clientIdAndroid, clientIdIos }
  // Built-in OAuth client IDs (public installed-app clients — NOT secrets; the
  // iOS id is even embedded in the app's URL scheme). A stored CONFIG_KEY
  // overrides these. The reversed-client-id redirect scheme must also be
  // registered natively (iOS Info.plist CFBundleURLSchemes / Android manifest).
  const DEFAULT_CONFIG = {
    clientIdIos: '806495706886-mgaafth2nul8p9p95ni58tsrdb6s40ds.apps.googleusercontent.com',
    clientIdAndroid: '806495706886-16ji081b8cp9dh9sdokedicc19sv17e6.apps.googleusercontent.com',
  };
  const TOKENS_KEY = 'GDRIVE_TOKENS_V1';   // { access_token, refresh_token, expiry, email }
  const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const REDIRECT_PATH = ':/oauth2redirect';   // appended to the reversed-client-id scheme

  let _config = null;
  let _tokens = null;
  let _loaded = false;
  let _pendingAuth = null;   // { resolve, reject, state, verifier, timer }

  // ---- prefs (dual-write, mirrors the app's convention) --------------------
  const CapPrefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  async function prefGet(key) {
    try {
      if (CapPrefs()) { const r = await CapPrefs().get({ key }); return r.value; }
    } catch (_) {}
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  async function prefSet(key, value) {
    try { if (CapPrefs()) await CapPrefs().set({ key, value: String(value) }); } catch (_) {}
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }
  async function prefRemove(key) {
    try { if (CapPrefs()) await CapPrefs().remove({ key }); } catch (_) {}
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function platform() {
    try { return (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web'; }
    catch (_) { return 'web'; }
  }

  async function loadState() {
    if (_loaded) return;
    let stored = null;
    try { const c = await prefGet(CONFIG_KEY); if (c) stored = JSON.parse(c); } catch (_) {}
    _config = Object.assign({}, DEFAULT_CONFIG, stored || {});   // stored overrides built-in
    try { const t = await prefGet(TOKENS_KEY); if (t) _tokens = JSON.parse(t); } catch (_) {}
    _loaded = true;
  }

  async function setConfig(cfg) {
    _config = Object.assign({}, _config, cfg || {});
    await prefSet(CONFIG_KEY, JSON.stringify(_config));
    return _config;
  }

  // The OAuth client id for THIS platform.
  function clientId() {
    if (!_config) return null;
    const p = platform();
    if (p === 'ios') return _config.clientIdIos || null;
    if (p === 'android') return _config.clientIdAndroid || null;
    // web/dev: prefer whichever is set (for desktop testing only)
    return _config.clientIdAndroid || _config.clientIdIos || null;
  }

  // Reversed-client-id redirect scheme. A Google client id looks like
  // "1234567-abcdef.apps.googleusercontent.com"; the reversed scheme is
  // "com.googleusercontent.apps.1234567-abcdef".
  function redirectUri() {
    const id = clientId();
    if (!id) return null;
    const head = id.replace(/\.apps\.googleusercontent\.com$/i, '');
    return 'com.googleusercontent.apps.' + head + REDIRECT_PATH;
  }

  async function isConfigured() { await loadState(); return !!clientId(); }
  async function isConnected() { await loadState(); return !!(_tokens && _tokens.refresh_token); }
  async function connectedEmail() { await loadState(); return (_tokens && _tokens.email) || null; }

  // ---- PKCE ----------------------------------------------------------------
  function randString(len) {
    const bytes = new Uint8Array(len);
    (crypto.getRandomValues ? crypto : window.crypto).getRandomValues(bytes);
    return b64url(bytes).slice(0, len);
  }
  function b64url(bytes) {
    let s = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function makePkce() {
    const verifier = randString(96);
    try {
      if (crypto.subtle && crypto.subtle.digest) {
        const data = new TextEncoder().encode(verifier);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return { verifier, challenge: b64url(digest), method: 'S256' };
      }
    } catch (_) {}
    // Fallback: Google accepts the 'plain' method (challenge == verifier).
    return { verifier, challenge: verifier, method: 'plain' };
  }

  // ---- HTTP (WebView fetch, falling back to native CapacitorHttp) ----------
  function nativeHttp() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  }
  async function postForm(url, params) {
    const body = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    // Try WebView fetch first.
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (_) {}
      if (r.ok && json) return json;
      // Non-OK with a JSON error body: surface it (don't fall through to native).
      if (json && json.error) throw new Error(json.error_description || json.error);
    } catch (e) {
      if (e && e.message && /error/i.test(e.message) && !/load failed|fetch|network/i.test(e.message)) throw e;
      // else: network/CORS — try native.
    }
    const http = nativeHttp();
    if (!http) throw new Error('Network error contacting Google');
    const resp = await http.request({
      url, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
    });
    const data = (typeof resp.data === 'string')
      ? (() => { try { return JSON.parse(resp.data); } catch (_) { return null; } })()
      : resp.data;
    if (resp.status >= 200 && resp.status < 300 && data) return data;
    throw new Error((data && (data.error_description || data.error)) || ('Google token error ' + resp.status));
  }

  // ---- redirect capture ----------------------------------------------------
  function decodeIdTokenEmail(idToken) {
    try {
      const payload = idToken.split('.')[1];
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      const obj = JSON.parse(json);
      return obj.email || null;
    } catch (_) { return null; }
  }

  function onRedirect(url) {
    if (!_pendingAuth) return;
    const ru = redirectUri();
    if (!ru) return;
    const scheme = ru.split(':')[0];   // com.googleusercontent.apps.<id>
    if (!url || url.indexOf(scheme + ':') !== 0) return;   // not ours
    let params;
    try {
      const q = url.split('?')[1] || '';
      params = new URLSearchParams(q);
    } catch (_) { params = null; }
    const closeBrowser = () => { try { window.Capacitor?.Plugins?.Browser?.close?.(); } catch (_) {} };
    closeBrowser();
    const pa = _pendingAuth;
    if (params && params.get('state') !== pa.state) { return; }   // CSRF guard; ignore stray
    if (params && params.get('error')) { settleAuth(null, new Error(params.get('error'))); return; }
    const code = params && params.get('code');
    if (!code) { settleAuth(null, new Error('No authorization code returned')); return; }
    settleAuth(code, null);
  }
  function settleAuth(code, err) {
    const pa = _pendingAuth; _pendingAuth = null;
    if (!pa) return;
    if (pa.timer) clearTimeout(pa.timer);
    if (err) pa.reject(err); else pa.resolve(code);
  }
  let _listenerArmed = false;
  function armListener() {
    if (_listenerArmed) return;
    const App = window.Capacitor?.Plugins?.App;
    if (App && App.addListener) {
      try {
        App.addListener('appUrlOpen', (data) => onRedirect((data && data.url) || ''));
        _listenerArmed = true;
      } catch (_) {}
    }
  }
  [100, 300, 600, 1200, 2500].forEach(ms => setTimeout(armListener, ms));

  // ---- public flow ---------------------------------------------------------

  // Interactive consent. Returns { email }. Throws on cancel/error.
  async function connect() {
    await loadState();
    const cid = clientId();
    const ru = redirectUri();
    if (!cid || !ru) throw new Error('Google Drive not configured — set client IDs first');
    armListener();
    const Browser = window.Capacitor?.Plugins?.Browser;
    if (!Browser || !Browser.open) throw new Error('@capacitor/browser is not installed');

    const pkce = await makePkce();
    const state = randString(24);
    const authUrl = AUTH_URL + '?' + [
      'client_id=' + encodeURIComponent(cid),
      'redirect_uri=' + encodeURIComponent(ru),
      'response_type=code',
      'scope=' + encodeURIComponent(SCOPES),
      'code_challenge=' + encodeURIComponent(pkce.challenge),
      'code_challenge_method=' + pkce.method,
      'state=' + encodeURIComponent(state),
      'access_type=offline',      // request a refresh_token
      'prompt=consent',           // force refresh_token on re-consent
    ].join('&');

    const code = await new Promise((resolve, reject) => {
      if (_pendingAuth) { try { _pendingAuth.reject(new Error('superseded')); } catch (_) {} }
      _pendingAuth = { resolve, reject, state, verifier: pkce.verifier,
        timer: setTimeout(() => settleAuth(null, new Error('Sign-in timed out')), 180000) };
      Browser.open({ url: authUrl }).catch((e) => settleAuth(null, e));
    });

    const tok = await postForm(TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      client_id: cid,
      redirect_uri: ru,
      code_verifier: pkce.verifier,
    });
    if (!tok.access_token) throw new Error('Token exchange failed');
    // Google's consent screen lets the user DESELECT the Drive permission while still
    // approving sign-in (openid/email). That yields a token with NO drive scope, so
    // every later Drive call 403s "insufficient authentication scopes". Catch it here
    // and refuse the connection with an actionable message rather than saving a token
    // that can sign in but can't sync. (tok.scope = the actually-granted scopes.)
    const granted = String(tok.scope || '');
    if (granted && granted.indexOf('drive') === -1) {
      throw new Error('Google Drive permission was not granted (got: ' + (granted || 'none') + '). Reconnect and keep the Drive checkbox checked on the consent screen.');
    }
    _tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || (_tokens && _tokens.refresh_token) || null,
      expiry: Date.now() + ((tok.expires_in || 3600) * 1000),
      email: decodeIdTokenEmail(tok.id_token || '') || (_tokens && _tokens.email) || null,
      scope: granted || (_tokens && _tokens.scope) || null,
    };
    await prefSet(TOKENS_KEY, JSON.stringify(_tokens));
    return { email: _tokens.email };
  }

  async function refresh() {
    await loadState();
    const cid = clientId();
    if (!cid || !_tokens || !_tokens.refresh_token) throw new Error('Not connected to Google Drive');
    let tok;
    try {
      tok = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: _tokens.refresh_token,
        client_id: cid,
      });
    } catch (e) {
      // A revoked/expired refresh token (Google: invalid_grant / "expired or revoked")
      // is PERMANENT — the connection is dead. Clear it so isConnected()→false and the
      // UI stops showing "connected" + prompts a reconnect. Transient/network errors are
      // rethrown WITHOUT disconnecting so a later retry still works.
      const msg = (e && e.message) ? String(e.message) : '';
      if (/invalid_grant|expired or revoked|revoked|invalid_request|unauthorized_client|invalid_client/i.test(msg)) {
        try { await disconnect(); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('kai:gdrive-disconnected')); } catch (_) {}
        throw new Error('Google Drive access expired — please reconnect.');
      }
      throw e;
    }
    if (!tok.access_token) throw new Error('Token refresh failed');
    _tokens.access_token = tok.access_token;
    _tokens.expiry = Date.now() + ((tok.expires_in || 3600) * 1000);
    if (tok.id_token) _tokens.email = decodeIdTokenEmail(tok.id_token) || _tokens.email;
    await prefSet(TOKENS_KEY, JSON.stringify(_tokens));
    return _tokens.access_token;
  }

  // Valid access token, refreshing when within 60s of expiry. Throws if not
  // connected (caller should prompt connect()).
  async function getAccessToken() {
    await loadState();
    if (!_tokens || !_tokens.refresh_token) throw new Error('Not connected to Google Drive');
    if (!_tokens.access_token || Date.now() > (_tokens.expiry - 60000)) return await refresh();
    return _tokens.access_token;
  }

  async function disconnect() {
    _tokens = null;
    await prefRemove(TOKENS_KEY);
  }

  window.gdriveAuth = {
    setConfig,
    isConfigured,
    isConnected,
    connectedEmail,
    connect,
    disconnect,
    getAccessToken,
    redirectUri,   // exposed so settings UI can show the exact scheme to register
  };
})();

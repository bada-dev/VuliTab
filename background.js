//...!
const API_BASE = 'https://studybuddy-r616.onrender.com';
const DEFAULT_SETTINGS = { guard: true, focusLock: true };
const SNOOZE_SECONDS = 300;

// ---------- tiny storage helpers ----------
function nowSec() { return Math.floor(Date.now() / 1000); }
async function get(keys) { return chrome.storage.local.get(keys); }
async function set(obj) { return chrome.storage.local.set(obj); }

async function apiPost(path, body) {
  const { token } = await get('token');
  const payload = Object.assign({}, body);
  if (token && payload.token === undefined) payload.token = token;
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    return { success: false, error: 'network' };
  }
}

// ---------- url helpers ----------
function domainOf(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, ''); }
  catch { return ''; }
}
function isSkippableUrl(url) {
  if (!url) return true;
  if (/^(chrome|edge|about|chrome-extension|view-source|devtools|moz-extension|file):/.test(url)) return true;
  if (url === 'about:blank' || url.startsWith('chrome://newtab')) return true;
  const d = domainOf(url);
  if (!d) return true;
  if (d.includes('chromewebstore.google.com')) return true;
  if (url.startsWith('https://chrome.google.com/webstore')) return true;
  return false;
}

async function activeTab() {
  try { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t; }
  catch { return null; }
}
async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}
async function getPageText(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ title: document.title || '', text: (document.body ? document.body.innerText : '').slice(0, 1600) }),
    });
    return r && r.result ? r.result : { title: '', text: '' };
  } catch { return { title: '', text: '' }; }
}
async function sendToTab(tabId, message) {
  try { await chrome.tabs.sendMessage(tabId, message); } catch { /* no content script there */ }
}

// ============================================================
// Focus-report accumulator (per session). Stored under 'report':
// { active, paused, mode, startedAt, prod, dist, neut, sites:{}, tracking, snoozes }
// tracking = { category, since, url, domain, title }
// ============================================================
async function getReport() { return (await get('report')).report || null; }
async function saveReport(r) { await set({ report: r }); }

async function beginReport(mode) {
  const r = { active: true, paused: false, mode, startedAt: nowSec(),
              prod: 0, dist: 0, neut: 0, sites: {}, tracking: null, snoozes: {} };
  await saveReport(r);
}

function addBucket(r, category, seconds, domain) {
  if (seconds <= 0) return;
  if (category === 'productive') r.prod += seconds;
  else if (category === 'distracted') r.dist += seconds;
  else r.neut += seconds;
  if (domain) {
    if (!r.sites[domain]) r.sites[domain] = { category, seconds: 0 };
    r.sites[domain].seconds += seconds;
    r.sites[domain].category = category;
  }
}

// Close out the time spent in the current category and reset the clock.
async function flushTracking(r) {
  if (!r || !r.active || r.paused || !r.tracking || !r.tracking.since) return r;
  const delta = nowSec() - r.tracking.since;
  addBucket(r, r.tracking.category, delta, r.tracking.domain);
  r.tracking.since = nowSec();
  return r;
}

async function evaluateTab(tab) {
  let r = await getReport();
  if (!r || !r.active || r.paused) return;
  if (!tab || isSkippableUrl(tab.url)) {
    // Blank / system / new tab — pause counting until they're on a real page.
    await flushTracking(r);
    r.tracking = { category: 'neutral', since: nowSec(), url: tab ? tab.url : '', domain: '', title: '' };
    await saveReport(r);
    return;
  }
  await flushTracking(r);
  const domain = domainOf(tab.url);
  r.tracking = { category: 'neutral', since: nowSec(), url: tab.url, domain, title: tab.title || '' };
  await saveReport(r);

  // Snoozed domain → leave neutral, no prompt/gate.
  if (r.snoozes && r.snoozes[domain] && r.snoozes[domain] > nowSec()) return;

  const { settings } = await get('settings');
  const guard = (settings || DEFAULT_SETTINGS).guard;
  if (!guard) return;

  const { profile } = await get('profile');
  const premium = !!(profile && profile.is_premium);

  if (premium) {
    // AI decides; user only asked when uncertain.
    const page = await getPageText(tab.id);
    const res = await apiPost('/classify-productivity', { url: tab.url, title: page.title || tab.title, text: page.text });
    if (!res || !res.success) {
      // fall back to asking
      await sendToTab(tab.id, { type: 'vtShowPrompt', reason: '', premium: true });
      return;
    }
    await applyVerdict(tab, res.verdict, res.reason, true);
  } else {
    // Free: ask the user about this tab.
    await sendToTab(tab.id, { type: 'vtShowPrompt', reason: '', premium: false });
  }
}

async function applyVerdict(tab, verdict, reason, premium) {
  let r = await getReport();
  if (!r || !r.active) return;
  const domain = domainOf(tab.url);
  if (!r.tracking || r.tracking.url !== tab.url) {
    // tab changed underneath us; ignore stale verdict
    if (!r.tracking || r.tracking.domain !== domain) return;
  }
  await flushTracking(r);
  if (verdict === 'productive') {
    r.tracking.category = 'productive';
    await saveReport(r);
  } else if (verdict === 'unproductive') {
    r.tracking.category = 'distracted';
    await saveReport(r);
    await maybeGate(tab, reason || 'This looks like a distraction.');
  } else {
    // uncertain → ask the user
    r.tracking.category = 'neutral';
    await saveReport(r);
    await sendToTab(tab.id, { type: 'vtShowPrompt', reason: reason || '', premium });
  }
}

async function maybeGate(tab, reason) {
  const { settings } = await get('settings');
  if (!(settings || DEFAULT_SETTINGS).focusLock) return;
  const domain = domainOf(tab.url);
  const r = await getReport();
  if (r && r.snoozes && r.snoozes[domain] && r.snoozes[domain] > nowSec()) return;
  await sendToTab(tab.id, { type: 'vtShowGate', reason });
}

async function handleProductiveAnswer(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
  const tab = await getTab(tabId);
  let r = await getReport();
  if (!r || !r.active) return { success: true };
  await flushTracking(r);
  if (r.tracking) {
    r.tracking.category = msg.productive ? 'productive' : 'distracted';
    await saveReport(r);
  }
  if (!msg.productive && tab) await maybeGate(tab, 'You marked this as not productive.');
  return { success: true };
}

async function handleGateAction(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
  const tab = await getTab(tabId);
  const domain = tab ? domainOf(tab.url) : '';
  let r = await getReport();
  if (!r || !r.active) return { success: true };
  if (msg.action === 'allow') {
    await flushTracking(r);
    if (r.tracking) r.tracking.category = 'productive';
  } else if (msg.action === 'snooze') {
    if (!r.snoozes) r.snoozes = {};
    if (domain) r.snoozes[domain] = nowSec() + SNOOZE_SECONDS;
    await flushTracking(r);
    if (r.tracking) r.tracking.category = 'neutral';
  }
  await saveReport(r);
  return { success: true };
}

// ============================================================
// Session lifecycle (driven by the popup, kept in sync with the backend).
// ============================================================
async function sessionUpdate({ mode, status, baseSeconds, targetSeconds }) {
  mode = ['focus', 'stopwatch', 'long'].includes(mode) ? mode : 'focus';
  const data = await apiPost('/session-update', {
    mode, status, baseSeconds: baseSeconds || 0, targetSeconds: targetSeconds || 0, source: 'vulitab',
  });
  if (data && data.success) {
    if (status === 'running') {
      if (mode === 'long') {
        // Breaks don't get a distraction guard — just keep the timer synced.
        await set({ report: null });
      } else {
        let r = await getReport();
        if (!r || !r.active) { await beginReport(mode); }
        else { r.paused = false; r.mode = mode; await saveReport(r); }
        const tab = await activeTab();
        await evaluateTab(tab);
      }
      ensureAlarm();
    } else if (status === 'paused') {
      let r = await getReport();
      if (r) { await flushTracking(r); r.paused = true; await saveReport(r); }
    } else {
      await finishReport();
    }
    await updateBadge();
  }
  return data;
}

async function finishReport() {
  let r = await getReport();
  if (!r || !r.active) { await updateBadge(); return; }
  await flushTracking(r);
  const total = r.prod + r.dist + r.neut;
  if (total >= 30) {
    const sites = Object.entries(r.sites)
      .map(([domain, v]) => ({ domain, category: v.category, seconds: v.seconds }))
      .sort((a, b) => b.seconds - a.seconds).slice(0, 12);
    const saved = await apiPost('/focus-session-save', {
      productiveSeconds: r.prod, distractedSeconds: r.dist, neutralSeconds: r.neut,
      startedAt: r.startedAt, endedAt: nowSec(), sites,
    });
    const focusScore = saved && saved.success ? saved.focusScore
      : Math.round(100 * r.prod / total);
    await set({ lastReport: { prod: r.prod, dist: r.dist, neut: r.neut, focusScore, sites, endedAt: nowSec() } });
  }
  await set({ report: null });
  await updateBadge();
}

// Periodically reconcile with the backend so a session started/stopped on the
// PHONE also flips guard on/off here, and keep buckets fresh.
async function syncWithBackend() {
  const { token } = await get('token');
  if (!token) return;
  let r = await getReport();
  if (r && r.active && !r.paused) await flushTracking(r);  // keep time accurate
  if (r) await saveReport(r);

  const s = await apiPost('/session-get', {});
  if (!s || !s.success) return;
  const sess = s.session;
  const running = sess && sess.status === 'running' && sess.mode !== 'long';
  r = await getReport();
  if (running) {
    if (!r || !r.active) {
      await beginReport(sess.mode || 'focus');
      const tab = await activeTab();
      await evaluateTab(tab);
      ensureAlarm();
    } else if (r.paused) {
      r.paused = false; await saveReport(r);
      const tab = await activeTab();
      await evaluateTab(tab);
    }
  } else {
    if (r && r.active) {
      if (sess && sess.status === 'paused') { await flushTracking(r); r.paused = true; await saveReport(r); }
      else { await finishReport(); }
    }
  }
  await updateBadge();
}

async function updateBadge() {
  const r = await getReport();
  if (r && r.active && !r.paused) {
    chrome.action.setBadgeText({ text: '•' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else if (r && r.active && r.paused) {
    chrome.action.setBadgeText({ text: '❚❚' });
    chrome.action.setBadgeBackgroundColor({ color: '#c9a14a' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function ensureAlarm() {
  chrome.alarms.create('vt_tick', { periodInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vt_tick') syncWithBackend(); });

// ---------- drawing ----------
async function startDraw() {
  const tab = await activeTab();
  if (!tab || isSkippableUrl(tab.url)) return { success: false, error: "Can't draw on this page." };
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content-draw.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-draw.js'] });
    return { success: true };
  } catch (e) { return { success: false, error: String(e) }; }
}

// ============================================================
// Message router
// ============================================================
async function handle(msg, sender) {
  switch (msg.type) {
    case 'login': {
      const data = await apiPost('/login', { username: msg.username, password: msg.password, platform: 'vulitab' });
      if (data && data.success) await set({ token: data.token, profile: data.profile });
      return data;
    }
    case 'logout': {
      await apiPost('/vt-logout', {});
      await chrome.storage.local.remove(['token', 'profile', 'report', 'lastReport']);
      await updateBadge();
      return { success: true };
    }
    case 'authState': {
      const { token, profile } = await get(['token', 'profile']);
      return { success: true, loggedIn: !!token, profile: profile || null };
    }
    case 'refreshProfile': {
      const data = await apiPost('/vt-profile', {});
      if (data && data.success) await set({ profile: data.profile });
      return data;
    }
    case 'sessionGet': return apiPost('/session-get', {});
    case 'sessionUpdate': return sessionUpdate(msg);
    case 'reportState': {
      const r = await getReport();
      return { success: true, report: r ? { prod: r.prod, dist: r.dist, neut: r.neut, active: r.active, paused: r.paused } : null };
    }
    case 'getSettings': { const { settings } = await get('settings'); return { success: true, settings: settings || DEFAULT_SETTINGS }; }
    case 'setSettings': { await set({ settings: Object.assign({}, DEFAULT_SETTINGS, msg.settings) }); return { success: true }; }
    case 'startDraw': return startDraw();
    case 'focusHistory': return apiPost('/focus-history', {});
    case 'getLastReport': { const { lastReport } = await get('lastReport'); return { success: true, report: lastReport || null }; }
    case 'productiveAnswer': return handleProductiveAnswer(msg, sender);
    case 'gateAction': return handleGateAction(msg, sender);
  }
  return { success: false, error: 'unknown' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ success: false, error: String(e) }));
  return true; // async
});

// ---------- tab activity → distraction detection ----------
async function maybeEvaluate(tab) {
  const r = await getReport();
  if (!r || !r.active || r.paused) return;
  await evaluateTab(tab);
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTab(tabId);
  if (tab) maybeEvaluate(tab);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab && tab.active) maybeEvaluate(tab);
});
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  const tab = await activeTab();
  if (tab) maybeEvaluate(tab);
});

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); });

//a
const API_BASE = 'https://studybuddy-r616.onrender.com';
const DEFAULT_SETTINGS = { guard: true, focusLock: true };
const SNOOZE_SECONDS = 300;

function nowSec() { return Math.floor(Date.now() / 1000); }
async function get(keys) { return chrome.storage.local.get(keys); }
async function set(obj) { return chrome.storage.local.set(obj); }

async function apiPost(path, body) {
  const { token } = await get('token');
  const payload = Object.assign({}, body);
  if (token && payload.token === undefined) payload.token = token;
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return await res.json();
  } catch { return { success: false, error: 'network' }; }
}

// ---------- url helpers ----------
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function isSkippableUrl(url) {
  if (!url) return true;
  if (/^(chrome|edge|about|chrome-extension|view-source|devtools|moz-extension):/.test(url)) return true;
  if (url === 'about:blank' || url.startsWith('chrome://newtab')) return true;
  const d = domainOf(url);
  if (!d) return true;
  if (d.includes('chromewebstore.google.com')) return true;
  if (url.startsWith('https://chrome.google.com/webstore')) return true;
  return false;
}
async function activeTab() { try { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t; } catch { return null; } }
async function getTab(id) { try { return await chrome.tabs.get(id); } catch { return null; } }
async function getPageText(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId },
      func: () => ({ title: document.title || '', text: (document.body ? document.body.innerText : '').slice(0, 1600) }) });
    return r && r.result ? r.result : { title: '', text: '' };
  } catch { return { title: '', text: '' }; }
}
async function sendToTab(tabId, message) { try { await chrome.tabs.sendMessage(tabId, message); } catch {} }

// ============================================================
// Focus report accumulator + distraction-replay events.
// report = { active,paused,mode,startedAt,prod,dist,neut,sites,tracking,events,snoozes }
// ============================================================
async function getReport() { return (await get('report')).report || null; }
async function saveReport(r) { await set({ report: r }); }
async function beginReport(mode) {
  await saveReport({ active: true, paused: false, mode, startedAt: nowSec(),
    prod: 0, dist: 0, neut: 0, sites: {}, tracking: null, events: [], snoozes: {} });
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
async function flushTracking(r) {
  if (!r || !r.active || r.paused || !r.tracking || !r.tracking.since) return r;
  const delta = nowSec() - r.tracking.since;
  addBucket(r, r.tracking.category, delta, r.tracking.domain);
  if (r.events && r.events.length) {
    const ev = r.events[r.events.length - 1];
    ev.seconds += delta;
    ev.category = r.tracking.category;
  }
  r.tracking.since = nowSec();
  return r;
}

async function evaluateTab(tab) {
  let r = await getReport();
  if (!r || !r.active || r.paused) return;

  // website blocklist runs first — it can hard-stop a page.
  if (tab && !isSkippableUrl(tab.url) && await enforceBlock(tab)) {
    // treated as distracted below as well
  }

  if (!tab || isSkippableUrl(tab.url)) {
    await flushTracking(r);
    r.tracking = { category: 'neutral', since: nowSec(), url: tab ? tab.url : '', domain: '', title: '' };
    await saveReport(r);
    return;
  }
  await flushTracking(r);
  const domain = domainOf(tab.url);
  r.tracking = { category: 'neutral', since: nowSec(), url: tab.url, domain, title: tab.title || '' };
  if (!r.events) r.events = [];
  if (r.events.length < 200) {
    r.events.push({ domain, title: (tab.title || '').slice(0, 80), category: 'neutral',
      start: nowSec() - r.startedAt, seconds: 0 });
  }
  await saveReport(r);

  if (r.snoozes && r.snoozes[domain] && r.snoozes[domain] > nowSec()) return;
  const { settings } = await get('settings');
  if (!(settings || DEFAULT_SETTINGS).guard) return;

  const { profile } = await get('profile');
  const premium = !!(profile && profile.is_premium);
  if (premium) {
    const page = await getPageText(tab.id);
    const res = await apiPost('/classify-productivity', { url: tab.url, title: page.title || tab.title, text: page.text });
    if (!res || !res.success) { await sendToTab(tab.id, { type: 'vtShowPrompt', premium: true }); return; }
    await applyVerdict(tab, res.verdict, res.reason, true);
  } else {
    await sendToTab(tab.id, { type: 'vtShowPrompt', premium: false });
  }
}

async function applyVerdict(tab, verdict, reason, premium) {
  let r = await getReport();
  if (!r || !r.active || !r.tracking) return;
  const domain = domainOf(tab.url);
  if (r.tracking.domain !== domain) return; // stale
  await flushTracking(r);
  if (verdict === 'productive') r.tracking.category = 'productive';
  else if (verdict === 'unproductive') { r.tracking.category = 'distracted'; await saveReport(r); await maybeGate(tab, reason || 'This looks like a distraction.'); return; }
  else { r.tracking.category = 'neutral'; await saveReport(r); await sendToTab(tab.id, { type: 'vtShowPrompt', reason, premium }); return; }
  await saveReport(r);
}

async function maybeGate(tab, reason) {
  const { settings } = await get('settings');
  if (!(settings || DEFAULT_SETTINGS).focusLock) return;
  const r = await getReport();
  const domain = domainOf(tab.url);
  if (r && r.snoozes && r.snoozes[domain] && r.snoozes[domain] > nowSec()) return;
  await sendToTab(tab.id, { type: 'vtShowGate', reason });
}

async function handleProductiveAnswer(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
  const tab = await getTab(tabId);
  let r = await getReport();
  if (!r || !r.active) return { success: true };
  await flushTracking(r);
  if (r.tracking) r.tracking.category = msg.productive ? 'productive' : 'distracted';
  await saveReport(r);
  if (!msg.productive && tab) await maybeGate(tab, 'You marked this as not productive.');
  return { success: true };
}

async function handleGateAction(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
  const tab = await getTab(tabId);
  const domain = tab ? domainOf(tab.url) : '';
  let r = await getReport();
  if (!r || !r.active) return { success: true };
  if (msg.action === 'allow') { await flushTracking(r); if (r.tracking) r.tracking.category = 'productive'; }
  else if (msg.action === 'snooze') { if (!r.snoozes) r.snoozes = {}; if (domain) r.snoozes[domain] = nowSec() + SNOOZE_SECONDS; await flushTracking(r); if (r.tracking) r.tracking.category = 'neutral'; }
  await saveReport(r);
  return { success: true };
}

// ============================================================
// Website blocklist enforcement (during a session only).
// ============================================================
async function blockedDomain(domain) {
  const { blocklist } = await get('blocklist');
  if (!blocklist || blocklist.mode === 'off' || !domain) return false;
  const sites = blocklist.sites || [];
  const match = sites.some((s) => domain === s || domain.endsWith('.' + s));
  if (blocklist.mode === 'block') return match;       // these are blocked
  if (blocklist.mode === 'allow') return !match;      // only these are allowed
  return false;
}
async function enforceBlock(tab) {
  const r = await getReport();
  if (!r || !r.active || r.paused) return false;      // only during a focus session
  if (!tab || isSkippableUrl(tab.url)) return false;
  const domain = domainOf(tab.url);
  if (await blockedDomain(domain)) {
    await sendToTab(tab.id, { type: 'vtShowBlock', domain });
    return true;
  }
  return false;
}

// ============================================================
// Session lifecycle (optimistic — popup updates UI first, this relays).
// ============================================================
async function sessionUpdate({ mode, status, baseSeconds, targetSeconds }) {
  mode = ['focus', 'stopwatch', 'long'].includes(mode) ? mode : 'focus';
  // 1) Persist the timer state to the backend FIRST — this is the only thing the
  //    other device needs to continue, and it's a single fast write.
  const data = await apiPost('/session-update', { mode, status, baseSeconds: baseSeconds || 0, targetSeconds: targetSeconds || 0, source: 'vulitab' });
  // 2) Guard/report bookkeeping runs OFF the critical path so starting a session
  //    is never blocked by tab classification (the old "5+ seconds to start").
  manageSessionLocal(mode, status); // intentionally not awaited
  return data;
}

async function manageSessionLocal(mode, status) {
  if (status === 'running') {
    if (mode === 'long') { await set({ report: null }); }
    else {
      let r = await getReport();
      if (!r || !r.active) await beginReport(mode);
      else { r.paused = false; r.mode = mode; await saveReport(r); }
      const tab = await activeTab();
      evaluateTab(tab); // classification is async; never blocks
    }
    ensureAlarm();
  } else if (status === 'paused') {
    let r = await getReport();
    if (r) { await flushTracking(r); r.paused = true; await saveReport(r); }
  } else { await finishReport(); }
  await updateBadge();
}

async function finishReport() {
  let r = await getReport();
  if (!r || !r.active) { await updateBadge(); return; }
  await flushTracking(r);
  const total = r.prod + r.dist + r.neut;
  if (total >= 30) {
    const sites = Object.entries(r.sites).map(([domain, v]) => ({ domain, category: v.category, seconds: v.seconds }))
      .sort((a, b) => b.seconds - a.seconds).slice(0, 14);
    const events = (r.events || []).filter((e) => e.seconds >= 2).slice(0, 120);
    const saved = await apiPost('/focus-session-save', {
      productiveSeconds: r.prod, distractedSeconds: r.dist, neutralSeconds: r.neut,
      startedAt: r.startedAt, endedAt: nowSec(), sites, events });
    const focusScore = saved && saved.success ? saved.focusScore : Math.round(100 * r.prod / total);
    await set({ lastReport: { prod: r.prod, dist: r.dist, neut: r.neut, focusScore, sites, events, endedAt: nowSec() } });
    // achievements
    if (focusScore >= 90) await apiPost('/achievement-unlock', { code: 'deep_focus' });
    if (r.dist === 0 && total >= 600) await apiPost('/achievement-unlock', { code: 'distraction_free' });
    await apiPost('/achievement-unlock', { code: 'browser_first_focus' });
  }
  await set({ report: null });
  await updateBadge();
}

// Keep the browser in lock-step with the phone (and keep buckets fresh).
async function syncWithBackend() {
  const { token } = await get('token');
  if (!token) return;
  let r = await getReport();
  if (r && r.active && !r.paused) { await flushTracking(r); await saveReport(r); }
  const s = await apiPost('/session-get', {});
  if (!s || !s.success) return;
  const sess = s.session;
  const running = sess && sess.status === 'running' && sess.mode !== 'long';
  r = await getReport();
  if (running) {
    if (!r || !r.active) { await beginReport(sess.mode || 'focus'); const tab = await activeTab(); await evaluateTab(tab); ensureAlarm(); }
    else if (r.paused) { r.paused = false; await saveReport(r); const tab = await activeTab(); await evaluateTab(tab); }
  } else if (r && r.active) {
    if (sess && sess.status === 'paused') { await flushTracking(r); r.paused = true; await saveReport(r); }
    else await finishReport();
  }
  await updateBadge();
}

async function updateBadge() {
  const r = await getReport();
  if (r && r.active && !r.paused) { chrome.action.setBadgeText({ text: '•' }); chrome.action.setBadgeBackgroundColor({ color: '#6BCF7F' }); }
  else if (r && r.active && r.paused) { chrome.action.setBadgeText({ text: '❚❚' }); chrome.action.setBadgeBackgroundColor({ color: '#FFB84D' }); }
  else chrome.action.setBadgeText({ text: '' });
}
function ensureAlarm() { chrome.alarms.create('vt_tick', { periodInMinutes: 1 }); }
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vt_tick') syncWithBackend(); });

// ---------- drawing ----------
async function startDraw() {
  const tab = await activeTab();
  if (!tab || isSkippableUrl(tab.url)) return { success: false, error: "This page type can't be drawn on (chrome:// and the Web Store are browser-locked)." };
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content-draw.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-draw.js'] });
    apiPost('/achievement-unlock', { code: 'artist' });
    return { success: true };
  } catch (e) { return { success: false, error: String(e) }; }
}

// ---------- on-page HUD (appears when you switch tabs mid-session) ----------
async function showHud(tab) {
  if (!tab || isSkippableUrl(tab.url)) return;
  const s = await apiPost('/session-get', {});
  if (!s || !s.success || !s.session || s.session.status !== 'running') return;
  await sendToTab(tab.id, { type: 'vtHud', session: s.session, serverTime: s.serverTime });
}

// ============================================================
// Message router
// ============================================================
async function handle(msg, sender) {
  switch (msg.type) {
    case 'open': { const { token, profile } = await get(['token', 'profile']); return { success: true, loggedIn: !!token, profile: profile || null }; }
    case 'login': {
      const data = await apiPost('/login', { username: msg.username, password: msg.password, platform: 'vulitab' });
      if (data && data.success) {
        await set({ token: data.token, profile: data.profile });
        const ach = await apiPost('/achievement-unlock', { code: 'vulitab_linked' });
        const bl = await apiPost('/blocklist-get', {});
        if (bl && bl.success) await set({ blocklist: { mode: bl.mode, sites: bl.sites } });
        data.linkedAchievement = ach && ach.newlyUnlocked ? ach.achievement : null;
      }
      return data;
    }
    case 'logout': { await apiPost('/vt-logout', {}); await chrome.storage.local.remove(['token', 'profile', 'report', 'lastReport', 'blocklist']); await updateBadge(); return { success: true }; }
    case 'authState': { const { token, profile } = await get(['token', 'profile']); return { success: true, loggedIn: !!token, profile: profile || null }; }
    case 'refreshProfile': { const d = await apiPost('/vt-profile', {}); if (d && d.success) await set({ profile: d.profile }); return d; }
    case 'sessionGet': return apiPost('/session-get', {});
    case 'sessionUpdate': return sessionUpdate(msg);
    case 'getSettings': { const { settings } = await get('settings'); return { success: true, settings: settings || DEFAULT_SETTINGS }; }
    case 'setSettings': { await set({ settings: Object.assign({}, DEFAULT_SETTINGS, msg.settings) }); return { success: true }; }
    case 'startDraw': return startDraw();
    case 'tasksSync': return apiPost('/tasks-sync', { tasks: msg.tasks || [] });
    case 'blocklistGet': { const d = await apiPost('/blocklist-get', {}); if (d && d.success) await set({ blocklist: { mode: d.mode, sites: d.sites } }); return d; }
    case 'blocklistSet': { const d = await apiPost('/blocklist-set', { mode: msg.mode, sites: msg.sites }); if (d && d.success) await set({ blocklist: { mode: d.mode, sites: d.sites } }); return d; }
    case 'achievements': return apiPost('/achievements-get', {});
    case 'analytics': return apiPost('/analytics', {});
    case 'focusHistory': return apiPost('/focus-history', {});
    case 'getLastReport': { const { lastReport } = await get('lastReport'); return { success: true, report: lastReport || null }; }
    case 'productiveAnswer': return handleProductiveAnswer(msg, sender);
    case 'gateAction': return handleGateAction(msg, sender);
    case 'blockAction': { const tabId = sender && sender.tab ? sender.tab.id : msg.tabId; if (msg.action === 'leave' && tabId) { try { await chrome.tabs.goBack(tabId); } catch {} } return { success: true }; }
  }
  return { success: false, error: 'unknown' };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ success: false, error: String(e) }));
  return true;
});

// ---------- tab activity ----------
async function onTab(tab) {
  if (!tab) return;
  const r = await getReport();
  const inSession = r && r.active && !r.paused;
  if (inSession) { await evaluateTab(tab); await showHud(tab); }
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => { const t = await getTab(tabId); if (t) onTab(t); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.status === 'complete' && tab && tab.active) onTab(tab); });
chrome.windows.onFocusChanged.addListener(async (w) => { if (w === chrome.windows.WINDOW_ID_NONE) return; const t = await activeTab(); if (t) onTab(t); });
chrome.webNavigation && chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return; const t = await getTab(d.tabId); if (t) { const r = await getReport(); if (r && r.active && !r.paused) await enforceBlock(t); }
});

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); });

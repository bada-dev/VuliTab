// ============================================================
// VuliTab popup — login, the synced buddy + timer, and the tool toggles.
// All network/state lives in the background worker; this file is UI only.
// ============================================================
function msg(type, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (r) => resolve(r || { success: false }));
  });
}
function $(id) { return document.getElementById(id); }

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function fmt(total) {
  total = Math.max(0, Math.floor(total));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function isNight() { const h = new Date().getHours(); return h >= 22 || h < 7; }

const COSMETIC_HTML = {
  tophat: '<div class="cm-tophat"><div class="crown"></div><div class="brim"></div></div>',
  wizard: '<div class="cm-wizard"><div class="cone"></div><div class="band"></div></div>',
  pirate: '<div class="cm-pirate"><div class="shell"><div class="skull">☠</div></div><div class="feather"></div></div>',
  'premium-crown': '<div class="cm-crown"><div class="points"><div class="point"></div><div class="point"></div><div class="point"></div></div><div class="band"></div></div>',
  'premium-shades': '<div class="cm-shades"><div class="arm-l"></div><div class="lens"></div><div class="bridge"></div><div class="lens"></div><div class="arm-r"></div></div>',
  'premium-glow': '<div class="cm-aura"></div>',
};

// ---------- app state ----------
let profile = null;
let settings = { guard: true, focusLock: true };
let currentMode = 'focus';
let selectedMin = 25;
let anchor = { status: 'idle', mode: 'focus', target: 0, elapsedAtFetch: 0, fetchedAt: Date.now(), source: 'app' };
let completedGuard = false;
let tickN = 0;

// ============================================================
// Buddy
// =======================================================
function renderProfile(p) {
  profile = p || profile;
  if (!profile) return;
  $('usernameLabel').textContent = profile.username || '—';
  $('premiumBadge').classList.toggle('hidden', !profile.is_premium);
  const h = new Date().getHours();
  $('greeting').textContent = h < 12 ? 'Good morning,' : h < 18 ? 'Good afternoon,' : 'Good evening,';
  $('statMinutes').textContent = profile.total_minutes || 0;
  $('statStreak').textContent = profile.streak || 0;
  const happy = Math.max(0, Math.min(100, profile.happiness == null ? 100 : profile.happiness));
  $('happyPct').textContent = Math.round(happy);
  $('happyFill').style.width = happy + '%';
  // width (clamped so it fits the popup)
  const w = Math.max(140, Math.min(200, profile.character_width || 140));
  $('vtCharacter').style.width = w + 'px';
  // cosmetic (hat slot synced from the app)
  $('vtCosmetics').innerHTML = COSMETIC_HTML[profile.equipped_cosmetic] || '';
  updateBuddyState();
}

function updateBuddyState() {
  const c = $('vtCharacter');
  const running = anchor.status === 'running';
  const happy = profile ? (profile.happiness == null ? 100 : profile.happiness) : 100;
  const cls = ['character'];
  if (running && (anchor.mode === 'focus' || anchor.mode === 'stopwatch')) cls.push('focused');
  else if (isNight()) cls.push('sleeping');
  if (happy <= 20) cls.push('very-sad');
  else if (happy <= 50) cls.push('sad');
  c.className = cls.join(' ');
  const gray = Math.max(0, 100 - happy * 2);
  c.style.filter = `saturate(${100 - gray}%) brightness(${100 - gray * 0.3}%)`;
}

// ============================================================
// Session / timer
// ==========================================================
async function fetchSession() {
  const d = await msg('sessionGet');
  if (!d || !d.success) return;
  const s = d.session;
  if (!s || s.status === 'idle') {
    anchor = { status: 'idle', mode: currentMode, target: 0, elapsedAtFetch: 0, fetchedAt: Date.now(), source: 'app' };
  } else {
    anchor = {
      status: s.status, mode: s.mode, target: s.target_seconds || 0,
      elapsedAtFetch: s.elapsed_seconds || 0, fetchedAt: Date.now(), source: s.source || 'app',
    };
    if (s.status === 'running') completedGuard = false;
    // reflect the live mode in the tab UI
    currentMode = s.mode;
    syncModeTabs();
  }
  renderControls();
  updateBuddyState();
}

function liveElapsed() {
  const drift = anchor.status === 'running' ? Math.floor((Date.now() - anchor.fetchedAt) / 1000) : 0;
  return anchor.elapsedAtFetch + drift;
}

function tickTimer() {
  const el = liveElapsed();
  if (anchor.status === 'idle') return; // preset shown by renderControls
  if (anchor.mode === 'stopwatch') {
    $('timerDisplay').textContent = fmt(el);
  } else {
    const remaining = Math.max(0, anchor.target - el);
    $('timerDisplay').textContent = fmt(remaining);
    if (remaining <= 0 && anchor.status === 'running' && !completedGuard) {
      completedGuard = true;
      onComplete();
    }
  }
}

function renderControls() {
  const primary = $('primaryBtn');
  const stop = $('stopBtn');
  const tabs = document.querySelectorAll('.vt-tab');
  const durRow = $('durationRow');
  const label = $('sessionLabel');

  if (anchor.status === 'idle') {
    tabs.forEach((t) => { t.style.pointerEvents = 'auto'; t.style.opacity = '1'; });
    durRow.style.display = currentMode === 'stopwatch' ? 'none' : 'flex';
    stop.classList.add('hidden');
    primary.classList.remove('hidden');
    primary.textContent = currentMode === 'stopwatch' ? 'Start Stopwatch' : currentMode === 'long' ? 'Start Break' : 'Start Focus';
    label.textContent = 'Ready to focus';
    // preset display
    $('timerDisplay').textContent = currentMode === 'stopwatch' ? '0:00' : fmt(selectedMin * 60);
  } else {
    tabs.forEach((t) => { t.style.pointerEvents = 'none'; t.style.opacity = '0.5'; });
    durRow.style.display = 'none';
    stop.classList.remove('hidden');
    if (anchor.status === 'paused') {
      primary.textContent = 'Resume';
      label.textContent = 'Paused';
    } else {
      primary.textContent = 'Pause';
      label.textContent = anchor.mode === 'long' ? 'On a break ☕'
        : anchor.mode === 'stopwatch' ? 'Tracking time' : 'Stay focused';
    }
  }
}

function syncModeTabs() {
  document.querySelectorAll('.vt-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === currentMode));
}

async function onPrimary() {
  if (anchor.status === 'idle') {
    let base = 0, target = 0;
    if (currentMode !== 'stopwatch') target = selectedMin * 60;
    await msg('sessionUpdate', { mode: currentMode, status: 'running', baseSeconds: base, targetSeconds: target });
    completedGuard = false;
    await fetchSession();
    if (settings.guard) toast(profile && profile.is_premium ? 'Session on — AI is watching your tabs 👀' : 'Session on — I’ll ask about each tab');
  } else if (anchor.status === 'running') {
    const el = liveElapsed();
    let base = 0, target = 0;
    if (anchor.mode === 'stopwatch') base = el; else target = Math.max(0, anchor.target - el);
    await msg('sessionUpdate', { mode: anchor.mode, status: 'paused', baseSeconds: base, targetSeconds: target });
    await fetchSession();
  } else { // paused → resume
    let base = 0, target = 0;
    if (anchor.mode === 'stopwatch') base = anchor.elapsedAtFetch;
    else target = Math.max(0, anchor.target - anchor.elapsedAtFetch);
    await msg('sessionUpdate', { mode: anchor.mode, status: 'running', baseSeconds: base, targetSeconds: target });
    await fetchSession();
  }
}

async function onStop() {
  await msg('sessionUpdate', { mode: anchor.mode || currentMode, status: 'idle', baseSeconds: 0, targetSeconds: 0 });
  await fetchSession();
  toast('Session ended — see your Focus Report 📊');
  setTimeout(() => { openReport(true); }, 900);
}

async function onComplete() {
  await msg('sessionUpdate', { mode: anchor.mode, status: 'idle', baseSeconds: 0, targetSeconds: 0 });
  const c = $('vtCharacter'); c.classList.add('happy'); setTimeout(() => c.classList.remove('happy'), 900);
  toast('Session complete! 🎉');
  await fetchSession();
  setTimeout(() => { openReport(true); }, 700);
}

// =====================
// Tools
// ============================================================
function renderSettings() {
  $('guardTool').classList.toggle('on', settings.guard);
  $('guardSub').textContent = settings.guard ? 'On' : 'Off';
  $('lockTool').classList.toggle('on', settings.focusLock);
  $('lockSub').textContent = settings.focusLock ? 'On' : 'Off';
}

async function openReport(force) {
  const panel = $('reportPanel');
  if (!force && !panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const last = await msg('getLastReport');
  const r = last && last.report;
  if (r) {
    const total = Math.max(1, r.prod + r.dist + r.neut);
    $('reportScore').textContent = (r.focusScore != null ? r.focusScore : Math.round(100 * r.prod / total)) + '%';
    const bars = $('reportBars');
    bars.innerHTML =
      `<div class="vt-rb-prod" style="width:${(100 * r.prod / total)}%"></div>` +
      `<div class="vt-rb-dist" style="width:${(100 * r.dist / total)}%"></div>` +
      `<div class="vt-rb-neut" style="width:${(100 * r.neut / total)}%"></div>`;
    $('legProd').textContent = Math.round(r.prod / 60) + 'm';
    $('legDist').textContent = Math.round(r.dist / 60) + 'm';
  } else {
    $('reportScore').textContent = '—';
    $('legProd').textContent = '0m'; $('legDist').textContent = '0m';
  }
  // history
  const hist = await msg('focusHistory');
  const list = $('historyList');
  list.innerHTML = '';
  if (hist && hist.success && hist.sessions && hist.sessions.length) {
    hist.sessions.slice(0, 6).forEach((s) => {
      const d = new Date((s.started_at || s.ended_at || 0) * 1000);
      const when = isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const mins = Math.round((s.productive_seconds + s.distracted_seconds + s.neutral_seconds) / 60);
      const row = document.createElement('div');
      row.className = 'vt-hist-item';
      row.innerHTML = `<span>${when} · ${mins}m</span><span><b>${s.focus_score}%</b> focus</span>`;
      list.appendChild(row);
    });
  } else {
    list.innerHTML = '<div class="vt-hist-item" style="border:none;color:#a89a82;">No sessions yet — start one to build your history.</div>';
  }
}

// ============================================================ WIRE HERE
function wire() {
  $('loginBtn').addEventListener('click', doLogin);
  $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').addEventListener('click', async () => { await msg('logout'); location.reload(); });

  document.querySelectorAll('.vt-tab').forEach((t) => t.addEventListener('click', () => {
    if (anchor.status !== 'idle') return;
    currentMode = t.dataset.mode;
    syncModeTabs();
    renderControls();
  }));
  document.querySelectorAll('.vt-dur').forEach((b) => b.addEventListener('click', () => {
    selectedMin = parseInt(b.dataset.min, 10);
    document.querySelectorAll('.vt-dur').forEach((x) => x.classList.toggle('active', x === b));
    renderControls();
  }));

  $('primaryBtn').addEventListener('click', onPrimary);
  $('stopBtn').addEventListener('click', onStop);

  $('drawTool').addEventListener('click', async () => {
    const d = await msg('startDraw');
    if (d && d.success) toast('Drawing enabled — switch to the page ✏️');
    else toast((d && d.error) || 'Cannot draw on this page');
  });
  $('guardTool').addEventListener('click', async () => {
    settings.guard = !settings.guard;
    await msg('setSettings', { settings });
    renderSettings();
    toast('Distraction guard ' + (settings.guard ? 'on' : 'off'));
  });
  $('lockTool').addEventListener('click', async () => {
    settings.focusLock = !settings.focusLock;
    await msg('setSettings', { settings });
    renderSettings();
    toast('Focus Lock ' + (settings.focusLock ? 'on' : 'off'));
  });
  $('reportTool').addEventListener('click', () => openReport(false));
}

async function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value;
  if (!u || !p) { $('loginError').textContent = 'Enter your username and password.'; return; }
  $('loginBtn').disabled = true; $('loginBtn').textContent = 'Logging in…';
  const d = await msg('login', { username: u, password: p });
  $('loginBtn').disabled = false; $('loginBtn').textContent = 'Log in';
  if (d && d.success) { await startApp(d.profile); }
  else if (d && d.error === 'no_password') { $('loginError').textContent = d.message || 'Set a password in the app first.'; }
  else { $('loginError').textContent = (d && d.error === 'network') ? 'Network error — try again.' : 'Incorrect username or password.'; }
}

async function startApp(p) {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  renderProfile(p);
  const st = await msg('getSettings');
  if (st && st.success) settings = st.settings;
  renderSettings();
  await fetchSession();
  renderControls();
  // live ticker
  setInterval(async () => {
    tickN++;
    tickTimer();
    if (tickN % 5 === 0) await fetchSession();          // catch cross-device changes
    if (tickN % 30 === 0) {                              // refresh stats/buddy here
      const pr = await msg('refreshProfile');
      if (pr && pr.success) renderProfile(pr.profile);
    }
  }, 1000);
}

async function init() {
  wire();
  const a = await msg('authState');
  if (a && a.loggedIn) await startApp(a.profile);
  else { $('loginView').classList.remove('hidden'); $('loginUser').focus(); }
}
document.addEventListener('DOMContentLoaded', init);

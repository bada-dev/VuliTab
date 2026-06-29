// MANY  flaws found on how i made it much slower.
function msg(type, extra) { return new Promise((res) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (r) => res(r || { success: false }))); }
function $(id) { return document.getElementById(id); }
function fmt(t) { t = Math.max(0, Math.floor(t)); const h = (t / 3600) | 0, m = ((t % 3600) / 60) | 0, s = t % 60, p = (n) => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`; }
function isNight() { const h = new Date().getHours(); return h >= 22 || h < 7; }
let toastT; function toast(x) { const t = $('toast'); t.textContent = x; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }

const COSMETIC_HTML = {
  tophat: '<div class="cm-tophat"><div class="crown"></div><div class="brim"></div></div>',
  'premium-crown': '<div class="cm-crown"><div class="points"><div class="point"></div><div class="point"></div><div class="point"></div></div><div class="band"></div></div>',
  'premium-shades': '<div class="cm-shades"><div class="arm-l"></div><div class="lens"></div><div class="bridge"></div><div class="lens"></div><div class="arm-r"></div></div>',
  'premium-glow': '<div class="cm-aura"></div>',
};

let profile = null, settings = { guard: true, focusLock: true };
let currentMode = 'focus', minutes = 25;
let anchor = { status: 'idle', mode: 'focus', target: 0, elapsedAtFetch: 0, fetchedAt: Date.now(), source: 'app' };
let completedGuard = false, lastAction = 0, tick = 0, activeTab = 'timer';
let tasks = [], syncTaskT = null;
let blocklist = { mode: 'off', sites: [] };

// ---------- profile / buddy ----------
function renderProfile(p) {
  profile = p || profile; if (!profile) return;
  document.body.classList.toggle('premium', !!profile.is_premium);
  $('userName').textContent = profile.username || '—';
  const h = new Date().getHours();
  $('greet').textContent = h < 12 ? 'Good morning,' : h < 18 ? 'Good afternoon,' : 'Good evening,';
  $('statMin').textContent = profile.total_minutes || 0;
  $('statStreak').textContent = profile.streak || 0;
  const hap = Math.max(0, Math.min(100, profile.happiness == null ? 100 : profile.happiness));
  $('happyPct').textContent = Math.round(hap); $('happyFill').style.width = hap + '%';
  $('vtCharacter').style.width = Math.max(120, Math.min(180, profile.character_width || 130)) + 'px';
  $('vtCosmetics').innerHTML = COSMETIC_HTML[profile.equipped_cosmetic] || '';
  updateBuddyState();
}
function updateBuddyState() {
  const c = $('vtCharacter'), running = anchor.status === 'running';
  const hap = profile ? (profile.happiness == null ? 100 : profile.happiness) : 100;
  const cls = ['character'];
  if (running && (anchor.mode === 'focus' || anchor.mode === 'stopwatch')) cls.push('focused');
  else if (isNight()) cls.push('sleeping');
  if (hap <= 20) cls.push('very-sad'); else if (hap <= 50) cls.push('sad');
  c.className = cls.join(' ');
  const gray = Math.max(0, 100 - hap * 2);
  c.style.filter = `saturate(${100 - gray}%) brightness(${100 - gray * 0.3}%)`;
}

// ---------- timer (optimistic) ----------
function liveElapsed() { const drift = anchor.status === 'running' ? ((Date.now() - anchor.fetchedAt) / 1000) | 0 : 0; return anchor.elapsedAtFetch + drift; }
function renderTimer() {
  const el = liveElapsed();
  if (anchor.status === 'idle') { $('timerBig').textContent = currentMode === 'stopwatch' ? '0:00' : fmt(minutes * 60); }
  else if (anchor.mode === 'stopwatch') { $('timerBig').textContent = fmt(el); }
  else {
    const rem = Math.max(0, anchor.target - el);
    $('timerBig').textContent = fmt(rem);
    if (rem <= 0 && anchor.status === 'running' && !completedGuard) { completedGuard = true; onComplete(); }
  }
  renderControls();
}
function renderControls() {
  const primary = $('primaryBtn'), stop = $('stopBtn'), pills = $('modePills'), mins = $('minutesArea'), label = $('timerLabel');
  if (anchor.status === 'idle') {
    pills.style.pointerEvents = 'auto'; pills.style.opacity = '1';
    mins.style.display = currentMode === 'stopwatch' ? 'none' : 'block';
    stop.classList.add('hidden'); primary.className = 'btn';
    primary.textContent = currentMode === 'stopwatch' ? 'Start Stopwatch' : currentMode === 'long' ? 'Start Break' : 'Start Focus';
    label.textContent = 'Ready to focus';
  } else {
    pills.style.pointerEvents = 'none'; pills.style.opacity = '.55';
    mins.style.display = 'none'; stop.classList.remove('hidden');
    if (anchor.status === 'paused') { primary.textContent = 'Resume'; primary.className = 'btn'; label.textContent = 'Paused'; }
    else { primary.textContent = 'Pause'; primary.className = 'btn pause'; label.textContent = anchor.mode === 'long' ? 'On a break ☕' : anchor.mode === 'stopwatch' ? 'Tracking time' : 'Stay focused 🎯'; }
  }
}
function syncPills() { document.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p.dataset.mode === currentMode)); }

function applySession(s) {
  if (Date.now() - lastAction < 1600) return; // don't fight a just-made local change
  if (!s || s.status === 'idle') { if (anchor.status !== 'idle') { anchor = { status: 'idle', mode: currentMode, target: 0, elapsedAtFetch: 0, fetchedAt: Date.now() }; } }
  else { anchor = { status: s.status, mode: s.mode, target: s.target_seconds || 0, elapsedAtFetch: s.elapsed_seconds || 0, fetchedAt: Date.now(), source: s.source || 'app' }; if (s.status === 'running') completedGuard = false; currentMode = s.mode; syncPills(); }
  renderTimer(); updateBuddyState();
}
async function fetchSession() { const d = await msg('sessionGet'); if (d && d.success) applySession(d.session); }

function send(status, base, target) {
  lastAction = Date.now();
  msg('sessionUpdate', { mode: anchor.mode || currentMode, status, baseSeconds: base || 0, targetSeconds: target || 0 });
}
function onPrimary() {
  if (anchor.status === 'idle') {
    const mode = currentMode, target = mode === 'stopwatch' ? 0 : minutes * 60;
    anchor = { status: 'running', mode, target, elapsedAtFetch: 0, fetchedAt: Date.now() };
    completedGuard = false; renderTimer(); updateBuddyState();
    lastAction = Date.now(); msg('sessionUpdate', { mode, status: 'running', baseSeconds: 0, targetSeconds: target });
    toast(settings.guard ? (profile && profile.is_premium ? 'Session on — AI is watching your tabs 👀' : 'Session on — I’ll check each tab') : 'Session started');
  } else if (anchor.status === 'running') {
    const el = liveElapsed();
    if (anchor.mode === 'stopwatch') { anchor.elapsedAtFetch = el; anchor.target = 0; } else { anchor.target = Math.max(0, anchor.target - el); anchor.elapsedAtFetch = 0; }
    anchor.status = 'paused'; anchor.fetchedAt = Date.now(); renderTimer(); updateBuddyState();
    send('paused', anchor.mode === 'stopwatch' ? anchor.elapsedAtFetch : 0, anchor.mode === 'stopwatch' ? 0 : anchor.target);
  } else { // resume
    anchor.status = 'running'; anchor.fetchedAt = Date.now(); renderTimer(); updateBuddyState();
    send('running', anchor.mode === 'stopwatch' ? anchor.elapsedAtFetch : 0, anchor.mode === 'stopwatch' ? 0 : anchor.target);
  }
}
function onStop() { anchor = { status: 'idle', mode: currentMode, target: 0, elapsedAtFetch: 0, fetchedAt: Date.now() }; renderTimer(); updateBuddyState(); send('idle', 0, 0); toast('Session ended'); setTimeout(() => { switchTab('stats'); }, 500); }
function onComplete() { anchor = { status: 'idle', mode: anchor.mode, target: 0, elapsedAtFetch: 0, fetchedAt: Date.now() }; const c = $('vtCharacter'); c.classList.add('happy'); setTimeout(() => c.classList.remove('happy'), 900); renderTimer(); updateBuddyState(); send('idle', 0, 0); toast('Session complete! 🎉'); setTimeout(() => switchTab('stats'), 700); }

// ---------- tabs ----------
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'tasks') loadTasks();
  if (name === 'stats') loadStats();
  if (name === 'settings') { loadSettings(); loadBlocklist(); }
  if (name === 'timer') fetchSession();
}

// ---------- tasks (two-way sync, optimistic) ----------
function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(36).slice(2)); }
function renderTasks() {
  const live = tasks.filter((t) => !t.deleted);
  const el = $('taskList');
  if (!live.length) { el.innerHTML = '<div class="empty">No tasks yet — add one above. They sync with the VuliStudy app.</div>'; return; }
  el.innerHTML = '';
  live.forEach((t) => {
    const d = document.createElement('div'); d.className = 'task-item' + (t.completed ? ' done' : '');
    d.innerHTML = `<div class="task-check ${t.completed ? 'done' : ''}">${t.completed ? '✓' : ''}</div><div class="task-text"></div><button class="task-del">✕</button>`;
    d.querySelector('.task-text').textContent = t.text;
    d.querySelector('.task-check').onclick = () => { t.completed = t.completed ? 0 : 1; t.updated_at = Math.floor(Date.now() / 1000); renderTasks(); syncTasks(); };
    d.querySelector('.task-del').onclick = () => { t.deleted = 1; t.updated_at = Math.floor(Date.now() / 1000); renderTasks(); syncTasks(); };
    el.appendChild(d);
  });
}
function addTask(text) { const now = Math.floor(Date.now() / 1000); tasks.push({ cid: uuid(), text, description: '', deadline: null, completed: 0, deleted: 0, updated_at: now, created_at: now }); renderTasks(); syncTasks(); }
function syncTasks() { clearTimeout(syncTaskT); syncTaskT = setTimeout(async () => { const d = await msg('tasksSync', { tasks }); if (d && d.success) { tasks = d.tasks; renderTasks(); } }, 350); }
async function loadTasks() { const d = await msg('tasksSync', { tasks }); if (d && d.success) { tasks = d.tasks; renderTasks(); } }

// ---------- premium card ----------
function premiumHTML() {
  if (profile && profile.is_premium) {
    return '<div class="premium-active"><div class="pa-ic">👑</div><div><b>VuliStudy+ active</b><span>AI distraction detection &amp; smart insights are on</span></div></div>';
  }
  return '<div class="premium-banner"><div class="pb-in"><h2>👑 Unlock VuliStudy+</h2><p>Let AI judge every tab automatically, get smart session insights, and more.</p><div class="feat"><span>🤖 AI tab detection</span><span>📊 Smart insights</span><span>🚫 Site blocking</span></div><p style="margin-top:10px;font-size:11px;">Redeem a VuliStudy+ code in the VuliStudy app.</p></div></div>';
}

// ---------- stats ----------
async function loadStats() {
  $('statsPremiumSlot').innerHTML = premiumHTML();
  const last = await msg('getLastReport'); const r = last && last.report;
  if (r) {
    const tot = Math.max(1, r.prod + r.dist + r.neut);
    $('repScore').textContent = (r.focusScore != null ? r.focusScore : Math.round(100 * r.prod / tot)) + '%';
    $('repBars').innerHTML = `<div class="bp" style="width:${100 * r.prod / tot}%"></div><div class="bd" style="width:${100 * r.dist / tot}%"></div><div class="bn" style="width:${100 * r.neut / tot}%"></div>`;
    $('repProd').textContent = Math.round(r.prod / 60) + 'm'; $('repDist').textContent = Math.round(r.dist / 60) + 'm';
    renderReplay(r.events || []);
  } else { $('repScore').textContent = '—'; $('repBars').innerHTML = ''; $('repProd').textContent = '0m'; $('repDist').textContent = '0m'; $('repReplay').innerHTML = '<div style="font-size:11px;color:#9a8a74;text-align:center;padding:6px;">Finish a session to see your replay.</div>'; }

  const an = await msg('analytics');
  if (an && an.success) {
    const days = an.daySeries || []; const maxv = Math.max(1, ...days.map((d) => d.prod + d.dist));
    $('dayChart').innerHTML = days.map((d) => { const ph = 56 * d.prod / maxv, dh = 56 * d.dist / maxv; const lbl = d.date.slice(5).replace('-', '/'); return `<div class="daybar" title="${d.date}"><div class="dp" style="height:${ph}px"></div><div class="dd" style="height:${dh}px"></div><div class="dl">${lbl}</div></div>`; }).join('') || '<div style="font-size:11px;color:#9a8a74;">No data yet.</div>';
    $('anStreak').textContent = an.streak || 0;
    $('anPeak').textContent = an.bestHour == null ? '—' : `${((an.bestHour % 12) || 12)}${an.bestHour < 12 ? 'am' : 'pm'}`;
    const ts = an.topSites || [];
    $('topSites').innerHTML = ts.length ? ts.map((s) => `<div class="siterow"><span><span class="dot">●</span> ${s.domain}</span><span>${Math.round(s.seconds / 60)}m</span></div>`).join('') : '<div style="font-size:11px;color:#9a8a74;">No distractions logged 🎉</div>';
  }

  const ac = await msg('achievements');
  if (ac && ac.success) $('achGrid').innerHTML = ac.achievements.map((a) => `<div class="ach ${a.unlocked ? 'unlocked' : ''}" title="${a.name}: ${a.desc}">${a.icon}</div>`).join('');

  const hi = await msg('focusHistory');
  if (hi && hi.success && hi.sessions && hi.sessions.length) {
    $('histList').innerHTML = hi.sessions.slice(0, 8).map((s, i) => { const d = new Date((s.started_at || s.ended_at || 0) * 1000); const when = isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); const mins = Math.round((s.productive_seconds + s.distracted_seconds + s.neutral_seconds) / 60); return `<div class="hist-item" data-i="${i}"><span>${when} · ${mins}m</span><span><b>${s.focus_score}%</b> focus</span></div>`; }).join('');
    document.querySelectorAll('.hist-item').forEach((it) => it.onclick = () => { const s = hi.sessions[+it.dataset.i]; renderReplay(s.events || []); $('panel-stats').scrollTop = 0; toast('Showing that session’s replay ↑'); });
  } else $('histList').innerHTML = '<div style="font-size:11px;color:#9a8a74;">No sessions yet.</div>';
}
function renderReplay(events) {
  const el = $('repReplay');
  if (!events || !events.length) { el.innerHTML = ''; return; }
  const max = Math.max(1, ...events.map((e) => e.seconds));
  el.innerHTML = '<div style="font-size:11px;color:#8a7a66;margin:8px 0 4px;">Distraction replay</div>' +
    events.slice(0, 12).map((e) => { const cls = e.category === 'productive' ? 'rp' : e.category === 'distracted' ? 'rd' : 'rn'; const w = Math.max(6, 150 * e.seconds / max); return `<div class="replay-row"><span style="width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.domain || 'page'}</span><div class="replay-bar ${cls}" style="width:${w}px"></div><span style="opacity:.7">${Math.round(e.seconds / 60) || '<1'}m</span></div>`; }).join('');
}

// ---------- settings + blocklist ----------
async function loadSettings() { $('setPremiumSlot').innerHTML = premiumHTML(); const d = await msg('getSettings'); if (d && d.success) settings = d.settings; $('guardSwitch').classList.toggle('on', settings.guard); $('lockSwitch').classList.toggle('on', settings.focusLock); $('guardSub').textContent = profile && profile.is_premium ? 'AI checks each tab you open' : 'Asks about each tab you open'; }
async function loadBlocklist() { const d = await msg('blocklistGet'); if (d && d.success) { blocklist = { mode: d.mode, sites: d.sites || [] }; renderBlocklist(); } }
function renderBlocklist() {
  document.querySelectorAll('.bl-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === blocklist.mode));
  const el = $('blList');
  el.innerHTML = blocklist.sites.length ? blocklist.sites.map((s) => `<div class="bl-item"><span>${s}</span><button data-s="${s}">✕</button></div>`).join('') : '<div style="font-size:11px;color:#9a8a74;padding:4px;">No sites yet.</div>';
  el.querySelectorAll('button').forEach((b) => b.onclick = () => { blocklist.sites = blocklist.sites.filter((x) => x !== b.dataset.s); renderBlocklist(); saveBlocklist(); });
}
function saveBlocklist() { msg('blocklistSet', { mode: blocklist.mode, sites: blocklist.sites }); }

// ---------- login ----------
async function doLogin() {
  const u = $('loginUser').value.trim(), p = $('loginPass').value;
  if (!u || !p) { $('loginErr').textContent = 'Enter your username and password.'; return; }
  $('loginBtn').disabled = true; $('loginBtn').textContent = 'Logging in…';
  const d = await msg('login', { username: u, password: p });
  $('loginBtn').disabled = false; $('loginBtn').textContent = 'Log in';
  if (d && d.success) { showShell(d.profile); if (d.linkedAchievement) setTimeout(() => toast(`🏆 Achievement: ${d.linkedAchievement.name}!`), 700); }
  else if (d && d.error === 'no_password') $('loginErr').textContent = d.message || 'Set a password in the app first.';
  else $('loginErr').textContent = d && d.error === 'network' ? 'Network error — try again.' : 'Incorrect username or password.';
}

// ---------- boot ----------
function showShell(p) {
  $('loginView').classList.add('hidden');
  $('shell').classList.remove('hidden'); requestAnimationFrame(() => $('shell').classList.add('show'));
  renderProfile(p);
  loadSettings();
  fetchSession();
  if (!showShell._ticking) {
    showShell._ticking = true;
    setInterval(() => {
      tick++; renderTimer();
      if (activeTab === 'timer' && tick % 2 === 0) fetchSession();           // 2s reconcile, only on timer tab
      if (tick % 30 === 0) msg('refreshProfile').then((d) => d && d.success && renderProfile(d.profile));
    }, 1000);
  }
}
function wire() {
  $('loginBtn').onclick = doLogin;
  $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').onclick = async () => { await msg('logout'); location.reload(); };
  document.querySelectorAll('.tabbtn').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
  document.querySelectorAll('.pill').forEach((p) => p.onclick = () => { if (anchor.status !== 'idle') return; currentMode = p.dataset.mode; syncPills(); renderTimer(); });
  $('minUp').onclick = () => setMinutes(minutes + 5);
  $('minDown').onclick = () => setMinutes(minutes - 5);
  document.querySelectorAll('.chip').forEach((c) => c.onclick = () => setMinutes(+c.dataset.min));
  $('primaryBtn').onclick = onPrimary;
  $('stopBtn').onclick = onStop;
  $('taskAddBtn').onclick = () => { const v = $('taskInput').value.trim(); if (v) { addTask(v); $('taskInput').value = ''; } };
  $('taskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('taskAddBtn').click(); });
  $('drawBtn').onclick = async () => { const d = await msg('startDraw'); toast(d && d.success ? 'Drawing on — switch to the page ✏️' : (d && d.error) || 'Cannot draw here'); };
  $('guardSwitch').onclick = () => { settings.guard = !settings.guard; msg('setSettings', { settings }); $('guardSwitch').classList.toggle('on', settings.guard); toast('Distraction guard ' + (settings.guard ? 'on' : 'off')); };
  $('lockSwitch').onclick = () => { settings.focusLock = !settings.focusLock; msg('setSettings', { settings }); $('lockSwitch').classList.toggle('on', settings.focusLock); toast('Focus Lock ' + (settings.focusLock ? 'on' : 'off')); };
  document.querySelectorAll('.bl-mode').forEach((b) => b.onclick = () => { blocklist.mode = b.dataset.mode; renderBlocklist(); saveBlocklist(); });
  $('blAddBtn').onclick = () => { let v = $('blInput').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; if (v && !blocklist.sites.includes(v)) { blocklist.sites.push(v); renderBlocklist(); saveBlocklist(); $('blInput').value = ''; } };
  $('blInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('blAddBtn').click(); });
}
function setMinutes(v) { minutes = Math.max(1, Math.min(180, v)); $('minVal').textContent = minutes; document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', +c.dataset.min === minutes)); if (anchor.status === 'idle') renderTimer(); }

async function boot() {
  wire();
  const a = await msg('open');
  $('bootView').classList.add('gone');
  setTimeout(() => $('bootView').classList.add('hidden'), 360);
  if (a && a.loggedIn) showShell(a.profile);
  else { $('loginView').classList.remove('hidden'); requestAnimationFrame(() => $('loginView').classList.add('show')); $('loginUser').focus(); }
}
document.addEventListener('DOMContentLoaded', boot);

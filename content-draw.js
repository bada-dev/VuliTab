
(() => {
  if (window.__vtDrawActive) {
    const bar = document.getElementById('vt-draw-bar');
    if (bar) { bar.style.transition = 'transform .15s'; bar.style.transform = 'translateX(-50%) scale(1.06)'; setTimeout(() => (bar.style.transform = 'translateX(-50%)'), 160); }
    return;
  }
  window.__vtDrawActive = true;

  const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#000000', '#ffffff'];

  const canvas = document.createElement('canvas');
  canvas.id = 'vt-draw-canvas';
  const ctx = canvas.getContext('2d');
  function sizeCanvas() {
    const data = canvas.width ? canvas.toDataURL() : null;
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    ctx.lineJoin = ctx.lineCap = 'round';
    if (data) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0); img.src = data; }
  }
  document.documentElement.appendChild(canvas);
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);

  let tool = 'pen', color = '#e53935', size = 4, drawing = false, pts = [];
  function pos(e) { const t = e.touches ? e.touches[0] : e; return { x: t.clientX, y: t.clientY }; }
  function stroke(a, b, ctrl) {
    if (tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = size * 4.5; }
    else { ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = size; ctx.strokeStyle = color; }
    ctx.beginPath(); ctx.moveTo(a.x, a.y);
    if (ctrl) ctx.quadraticCurveTo(ctrl.x, ctrl.y, b.x, b.y); else ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  function start(e) { if (tool === 'cursor') return; drawing = true; pts = [pos(e)]; e.preventDefault(); }
  function move(e) {
    if (!drawing || tool === 'cursor') return;
    pts.push(pos(e));
    const n = pts.length;
    if (n >= 3) {
      const p0 = pts[n - 3], p1 = pts[n - 2], p2 = pts[n - 1];
      const m1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const m2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      stroke(m1, m2, p1);                 // smooth quadratic through the midpoints
    } else if (n === 2) { stroke(pts[0], pts[1]); }
    e.preventDefault();
  }
  function end() { drawing = false; pts = []; }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end);

  const bar = document.createElement('div');
  bar.id = 'vt-draw-bar';
  bar.innerHTML = `
    <div class="vt-bar-head" id="vtBarHead">
      <span class="vt-bar-title">✏️ VuliTab Draw</span>
      <button class="vt-bar-x" id="vtBarClose" title="Clear & close">✕</button>
    </div>
    <div class="vt-tools-row">
      <button class="vt-dtool active" data-tool="pen" title="Pen">✏️</button>
      <button class="vt-dtool" data-tool="eraser" title="Eraser">🧽</button>
      <button class="vt-dtool" data-tool="cursor" title="Use the page (stop drawing)">🖱️</button>
    </div>
    <div class="vt-swatches" id="vtSwatches"></div>
    <div class="vt-size-row"><input type="range" min="1" max="26" value="4" id="vtSize"><span id="vtSizeLabel">4px</span></div>
    <button class="vt-bar-clear" id="vtClear">Clear all</button>
  `;
  document.documentElement.appendChild(bar);

  const sw = bar.querySelector('#vtSwatches');
  COLORS.forEach((c, i) => {
    const d = document.createElement('div'); d.className = 'vt-sw' + (i === 0 ? ' active' : '');
    d.style.background = c; d.title = c;
    d.onclick = () => { color = c; sw.querySelectorAll('.vt-sw').forEach((x) => x.classList.remove('active')); d.classList.add('active'); if (tool === 'cursor') setTool('pen'); };
    sw.appendChild(d);
  });
  function setTool(t) { tool = t; bar.querySelectorAll('.vt-dtool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t)); canvas.classList.toggle('vt-cursor-mode', t === 'cursor'); }
  bar.querySelectorAll('.vt-dtool').forEach((b) => b.onclick = () => setTool(b.dataset.tool));
  bar.querySelector('#vtSize').oninput = (e) => { size = +e.target.value; bar.querySelector('#vtSizeLabel').textContent = size + 'px'; };
  bar.querySelector('#vtClear').onclick = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

  function destroy() {
    window.removeEventListener('resize', sizeCanvas);
    window.removeEventListener('mouseup', end); window.removeEventListener('touchend', end);
    canvas.remove(); bar.remove(); window.__vtDrawActive = false;
  }
  bar.querySelector('#vtBarClose').onclick = destroy;

  // draggable toolbar
  (() => {
    const head = bar.querySelector('#vtBarHead'); let dragging = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', (e) => { dragging = true; const r = bar.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!dragging) return; bar.style.left = (e.clientX - ox) + 'px'; bar.style.top = (e.clientY - oy) + 'px'; bar.style.transform = 'none'; });
    window.addEventListener('mouseup', () => (dragging = false));
  })();
})();

// draw feautre...
(() => {
  if (window.__vtDrawActive) {
    // Already drawing — flash the toolbar so the user notices it.
    const bar = document.getElementById('vt-draw-bar');
    if (bar) { bar.style.transition = 'transform .15s'; bar.style.transform = 'scale(1.05)'; setTimeout(() => (bar.style.transform = ''), 160); }
    return;
  }
  window.__vtDrawActive = true;

  const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#000000', '#ffffff'];

  // ---- canvas ----
  const canvas = document.createElement('canvas');
  canvas.id = 'vt-draw-canvas';
  const ctx = canvas.getContext('2d');
  function sizeCanvas() {
    // preserve drawing across resize
    const prev = ctx.getImageData ? null : null;
    const data = canvas.width ? canvas.toDataURL() : null;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (data) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0); img.src = data; }
  }
  document.documentElement.appendChild(canvas);
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);

  // ---- state ----
  let tool = 'pen';       // pen | eraser | cursor
  let color = '#e53935';
  let size = 4;
  let drawing = false;
  let lastX = 0, lastY = 0;

  function pos(e) {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }
  function start(e) {
    if (tool === 'cursor') return;
    drawing = true;
    const p = pos(e);
    lastX = p.x; lastY = p.y;
    e.preventDefault();
  }
  function move(e) {
    if (!drawing || tool === 'cursor') return;
    const p = pos(e);
    ctx.lineJoin = ctx.lineCap = 'round';
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = size * 4;
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = size;
      ctx.strokeStyle = color;
    }
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x; lastY = p.y;
    e.preventDefault();
  }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end);

  // ---- toolbar ----
  const bar = document.createElement('div');
  bar.id = 'vt-draw-bar';
  bar.innerHTML = `
    <div class="vt-bar-head" id="vtBarHead">
      <span class="vt-bar-title">✏️ VuliTab Draw</span>
      <button class="vt-bar-x" id="vtBarClose" title="Close drawing">✕</button>
    </div>
    <div class="vt-tools-row">
      <button class="vt-dtool active" data-tool="pen" title="Pen">✏️</button>
      <button class="vt-dtool" data-tool="eraser" title="Eraser">🧽</button>
      <button class="vt-dtool" data-tool="cursor" title="Use the page">🖱️</button>
    </div>
    <div class="vt-swatches" id="vtSwatches"></div>
    <div class="vt-size-row">
      <input type="range" min="1" max="24" value="4" id="vtSize">
      <span id="vtSizeLabel">4px</span>
    </div>
    <button class="vt-bar-clear" id="vtClear">Clear all</button>
  `;
  document.documentElement.appendChild(bar);

  // swatches
  const sw = bar.querySelector('#vtSwatches');
  COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'vt-sw' + (i === 0 ? ' active' : '');
    d.style.background = c;
    d.title = c;
    d.addEventListener('click', () => {
      color = c;
      sw.querySelectorAll('.vt-sw').forEach((x) => x.classList.remove('active'));
      d.classList.add('active');
      if (tool === 'cursor') setTool('pen');
    });
    sw.appendChild(d);
  });

  function setTool(t) {
    tool = t;
    bar.querySelectorAll('.vt-dtool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    canvas.classList.toggle('vt-cursor-mode', t === 'cursor');
  }
  bar.querySelectorAll('.vt-dtool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  bar.querySelector('#vtSize').addEventListener('input', (e) => {
    size = parseInt(e.target.value, 10);
    bar.querySelector('#vtSizeLabel').textContent = size + 'px';
  });
  bar.querySelector('#vtClear').addEventListener('click', () => ctx.clearRect(0, 0, canvas.width, canvas.height));

  // close everything
  function destroy() {
    window.removeEventListener('resize', sizeCanvas);
    window.removeEventListener('mouseup', end);
    window.removeEventListener('touchend', end);
    canvas.remove();
    bar.remove();
    window.__vtDrawActive = false;
  }
  bar.querySelector('#vtBarClose').addEventListener('click', destroy);

  // drag the toolbar
  (() => {
    const head = bar.querySelector('#vtBarHead');
    let dragging = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = bar.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      bar.style.left = (e.clientX - ox) + 'px';
      bar.style.top = (e.clientY - oy) + 'px';
      bar.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => (dragging = false));
  })();
})();

// check if the current whatever the user on is productive, EVEN using AI to check if it is, ONLY IF PREMIUM
(() => {
  if (window.__vtFocusLoaded) return;
  window.__vtFocusLoaded = true;

  const host = document.createElement('div');
  host.id = 'vt-focus-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'open' });
  (document.documentElement || document.body).appendChild(host);

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
      .prompt {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-140%);
        background: #fff; color: #2D3142; border-radius: 14px; padding: 12px 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25); display: flex; align-items: center; gap: 12px;
        transition: transform .28s cubic-bezier(.34,1.56,.64,1); max-width: 460px;
      }
      .prompt.show { transform: translateX(-50%) translateY(0); }
      .prompt .q { font-size: 14px; font-weight: 600; }
      .prompt .sub { font-size: 11px; color: #8a7a66; }
      .btn { border: none; border-radius: 9px; padding: 8px 14px; font-size: 13px; font-weight: 700; cursor: pointer; }
      .yes { background: #6BCF7F; color: #133d1d; }
      .no { background: #e57373; color: #4d0f0f; }
      .x { background: none; color: #b3a690; font-size: 16px; cursor: pointer; border: none; }

      .gate {
        position: fixed; inset: 0; background: rgba(28,24,20,.78); backdrop-filter: blur(3px);
        display: none; align-items: center; justify-content: center; padding: 20px;
      }
      .gate.show { display: flex; }
      .card {
        background: #f5efe6; border-radius: 20px; padding: 26px 24px; max-width: 380px; width: 100%;
        text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.4);
      }
      .card h2 { margin: 14px 0 4px; font-size: 20px; color: #2D3142; }
      .card p { margin: 0 0 18px; font-size: 13px; color: #6a5a44; line-height: 1.5; }
      .gate-btns { display: flex; flex-direction: column; gap: 9px; }
      .primary { background: linear-gradient(135deg,#c4a07a,#a87652); color: #fff; }
      .ghost { background: #ece3d4; color: #5a4a36; }
      .link { background: none; color: #9a8a74; font-size: 12px; cursor: pointer; border: none; }

      /* mini buddy */
      .buddy { position: relative; width: 92px; height: 104px; margin: 0 auto; }
      .b-body { width: 100%; height: 100%; background: linear-gradient(135deg,#B8865C,#A87652 50%,#986652);
        border-radius: 48% 52% 48% 52% / 52% 55% 45% 48%; border: 2px solid rgba(0,0,0,.2);
        box-shadow: 0 8px 20px rgba(0,0,0,.2); position: relative; }
      .b-eyes { position: absolute; top: 36px; left: 50%; transform: translateX(-50%); display: flex; gap: 18px; }
      .b-eye { width: 13px; height: 9px; background: #2D3142; border-radius: 40% 40% 50% 50%; }
      .b-mouth { position: absolute; bottom: 28px; left: 50%; transform: translateX(-50%); width: 18px; height: 3px; background: #2D3142; border-radius: 2px; }
    </style>

    <div class="prompt" id="prompt">
      <div>
        <div class="q">📚 Is this tab productive for studying?</div>
        <div class="sub" id="promptSub"></div>
      </div>
      <button class="btn yes" id="yesBtn">Yes</button>
      <button class="btn no" id="noBtn">No</button>
      <button class="x" id="dismissBtn" title="Dismiss">✕</button>
    </div>

    <div class="gate" id="gate">
      <div class="card">
        <div class="buddy"><div class="b-body"><div class="b-eyes"><div class="b-eye"></div><div class="b-eye"></div></div><div class="b-mouth"></div></div></div>
        <h2>Hey — back to studying?</h2>
        <p id="gateReason">This page looks like a distraction while your focus session is running.</p>
        <div class="gate-btns">
          <button class="btn primary" id="gateBack">Okay, back to focus</button>
          <button class="btn ghost" id="gateAllow">This is actually productive</button>
          <button class="link" id="gateSnooze">Let me stay for 5 minutes</button>
        </div>
      </div>
    </div>
  `;

  const promptEl = root.getElementById('prompt');
  const gateEl = root.getElementById('gate');
  let promptTimer = null;

  function showPrompt(reason, premium) {
    root.getElementById('promptSub').textContent =
      reason ? reason : (premium ? 'Not sure this counts — you decide.' : 'Quick check during your session.');
    promptEl.classList.add('show');
    clearTimeout(promptTimer);
    // Auto-dismiss as "neutral" if ignored.
    promptTimer = setTimeout(() => promptEl.classList.remove('show'), 15000);
  }
  function hidePrompt() { promptEl.classList.remove('show'); clearTimeout(promptTimer); }
  function showGate(reason) {
    if (reason) root.getElementById('gateReason').textContent = reason;
    gateEl.classList.add('show');
  }
  function hideGate() { gateEl.classList.remove('show'); }

  function answer(productive) {
    hidePrompt();
    chrome.runtime.sendMessage({ type: 'productiveAnswer', productive });
  }
  root.getElementById('yesBtn').onclick = () => answer(true);
  root.getElementById('noBtn').onclick = () => answer(false);
  root.getElementById('dismissBtn').onclick = hidePrompt;

  root.getElementById('gateBack').onclick = () => { hideGate(); chrome.runtime.sendMessage({ type: 'gateAction', action: 'back' }); };
  root.getElementById('gateAllow').onclick = () => { hideGate(); chrome.runtime.sendMessage({ type: 'gateAction', action: 'allow' }); };
  root.getElementById('gateSnooze').onclick = () => { hideGate(); chrome.runtime.sendMessage({ type: 'gateAction', action: 'snooze' }); };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'vtShowPrompt') showPrompt(msg.reason, msg.premium);
    else if (msg.type === 'vtShowGate') showGate(msg.reason);
    else if (msg.type === 'vtHide') { hidePrompt(); hideGate(); }
    else if (msg.type === 'vtFlash') {
      // brief positive confirmation for premium "productive" verdicts
      root.getElementById('promptSub').textContent = '';
      showPrompt('✓ ' + (msg.reason || 'Productive — keep going!'), true);
      setTimeout(hidePrompt, 1800);
    }
  });
})();

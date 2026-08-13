/**
 * Browser-side recorder: floating overlay UI + DOM event capture.
 * Injected via Playwright context.addInitScript.
 *
 * Speaks to Node through window.opensecantRecord(payload) (exposeBinding).
 */
function getRecorderInjectSource() {
  return `(() => {
  if (window.__opensecantRecorderInstalled) return;
  window.__opensecantRecorderInstalled = true;

  const STATE = {
    recording: false,
    paused: true,
    started: false,
    steps: [],
    pendingFill: null,
    fillTimer: null,
    lastUrl: location.href,
  };

  try {
    if (sessionStorage.getItem('__osr_recording') === '1') {
      STATE.started = true;
      STATE.recording = true;
      STATE.paused = sessionStorage.getItem('__osr_paused') === '1';
    }
  } catch (_) {}

  const OVERLAY_ID = 'opensecant-recorder-overlay';
  const ATTR = 'data-opensecant-recorder';

  function persistRecState() {
    try {
      if (STATE.started && STATE.recording) {
        sessionStorage.setItem('__osr_recording', '1');
        sessionStorage.setItem('__osr_paused', STATE.paused ? '1' : '0');
      } else {
        sessionStorage.removeItem('__osr_recording');
        sessionStorage.removeItem('__osr_paused');
      }
    } catch (_) {}
  }

  function isRecorderNode(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('[' + ATTR + ']');
  }

  /** Ignore page-script / automation clicks (FAQ auto-expand, etc.). */
  function isUserEvent(e) {
    return !!(e && e.isTrusted);
  }

  function canCapture(e) {
    return STATE.recording && !STATE.paused && isUserEvent(e);
  }

  function truncate(s, n) {
    s = String(s || '').replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function collectTarget(el) {
    if (!el || el.nodeType !== 1) return null;
    const attrs = {};
    try {
      for (const a of el.attributes || []) {
        if (
          a.name === 'id' || a.name === 'name' || a.name === 'type' ||
          a.name === 'placeholder' || a.name === 'href' || a.name === 'role' ||
          a.name === 'aria-label' || a.name === 'title' || a.name === 'alt' ||
          a.name.startsWith('data-') || a.name === 'testdataid'
        ) {
          attrs[a.name] = a.value;
        }
      }
    } catch (_) {}

    let labelText = '';
    try {
            if (el.id) {
        const idEsc = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id.replace(/"/g, '\\\\"');
        const lab = document.querySelector('label[for="' + idEsc + '"]');
        if (lab) labelText = (lab.innerText || '').trim();
      }
      if (!labelText) {
        const wrap = el.closest && el.closest('label');
        if (wrap) labelText = (wrap.innerText || '').trim();
      }
    } catch (_) {}

    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const tag = (el.tagName || '').toLowerCase();
    let text = '';
    try {
      text = (el.innerText || el.textContent || '').trim().slice(0, 200);
    } catch (_) {}

    let value = undefined;
    try {
      if ('value' in el) value = el.value;
      if (el.type === 'checkbox' || el.type === 'radio') {
        value = !!el.checked;
      }
    } catch (_) {}

    return {
      tag,
      type: attrs.type || el.type || undefined,
      text,
      labelText: labelText || undefined,
      value,
      attributes: attrs,
      position: {
        x: Math.round(rect.x + (window.scrollX || 0)),
        y: Math.round(rect.y + (window.scrollY || 0)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function send(payload) {
    try {
      if (typeof window.opensecantRecord === 'function') {
        window.opensecantRecord(payload);
      }
    } catch (_) {}
  }

  function pushStep(step) {
    STATE.steps.push(step);
    renderSteps();
    send({ kind: 'step', step });
  }

  function flushFill() {
    if (!STATE.pendingFill) return;
    const { target, value } = STATE.pendingFill;
    STATE.pendingFill = null;
    if (STATE.fillTimer) {
      clearTimeout(STATE.fillTimer);
      STATE.fillTimer = null;
    }
    if (value == null || String(value) === '') return;
    pushStep({
      type: 'fill',
      timestamp: Date.now(),
      url: location.href,
      value: String(value),
      target,
    });
  }

  /** Buffer typing only — flush on blur / other actions, not on a short pause. */
  function scheduleFill(target, value) {
    STATE.pendingFill = { target, value };
    if (STATE.fillTimer) {
      clearTimeout(STATE.fillTimer);
      STATE.fillTimer = null;
    }
  }

  function isEditableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'select') return true;
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(t);
    }
    if (el.isContentEditable) return true;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  }

  function isCheckableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return true;
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    return role === 'checkbox' || role === 'switch' || role === 'radio';
  }

  function onKeyDown(e) {
    if (!canCapture(e)) return;
    if (isRecorderNode(e.target)) return;

    const key = e.key || '';
    const code = e.code || '';
    const isEnter = key === 'Enter' || code === 'Enter' || code === 'NumpadEnter';
    if (!isEnter) return;

    // Avoid duplicate if key is held down
    if (e.repeat) return;

    flushFill();
    const target = collectTarget(e.target);
    pushStep({
      type: 'press',
      key: 'Enter',
      timestamp: Date.now(),
      url: location.href,
      target,
    });
  }

  function onClick(e) {
    if (!canCapture(e)) return;
    if (isRecorderNode(e.target)) return;
    flushFill();

    const el = e.target;
    // Focusing a text field or toggling a checkbox is not a useful "Click" step
    if (isEditableElement(el) || isCheckableElement(el)) {
      return;
    }
    // Click on <label> that wraps / points to an input — let fill/check handle it
    if (el && el.closest) {
      const label = el.closest('label');
      if (label) {
        const forId = label.getAttribute('for');
        let control = null;
        try {
          if (forId) control = document.getElementById(forId);
          if (!control) control = label.querySelector('input, textarea, select');
        } catch (_) {}
        if (control && (isEditableElement(control) || isCheckableElement(control))) {
          return;
        }
      }
    }

    const target = collectTarget(el);
    if (!target) return;
    pushStep({
      type: 'click',
      timestamp: Date.now(),
      url: location.href,
      target,
    });
  }

  function onInput(e) {
    if (!canCapture(e)) return;
    if (isRecorderNode(e.target)) return;
    const el = e.target;
    if (!el || !('value' in el)) return;
    if (el.type === 'checkbox' || el.type === 'radio') return;
    const target = collectTarget(el);
    if (!target) return;
    scheduleFill(target, el.value);
  }

  function onBlur(e) {
    if (!STATE.recording || STATE.paused) return;
    if (isRecorderNode(e.target)) return;
    if (!STATE.pendingFill) return;
    // Commit the finished value when leaving the field
    flushFill();
  }

  function onChange(e) {
    if (!canCapture(e)) return;
    if (isRecorderNode(e.target)) return;
    const el = e.target;
    const target = collectTarget(el);
    if (!target) return;
    flushFill();

    if (el.tagName === 'SELECT') {
      const opt = el.options && el.options[el.selectedIndex];
      pushStep({
        type: 'select',
        timestamp: Date.now(),
        url: location.href,
        value: opt ? (opt.text || opt.value) : el.value,
        target,
      });
      return;
    }

    if (el.type === 'checkbox' || el.type === 'radio') {
      pushStep({
        type: el.checked ? 'check' : 'uncheck',
        timestamp: Date.now(),
        url: location.href,
        value: !!el.checked,
        target,
      });
    }
  }

  function checkNavigation() {
    if (!STATE.recording || STATE.paused) return;
    if (location.href === STATE.lastUrl) return;
    flushFill();
    STATE.lastUrl = location.href;
    pushStep({
      type: 'navigate',
      timestamp: Date.now(),
      url: location.href,
      target: null,
    });
  }

  function ensureOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    if (!document.body) return;

    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute(ATTR, '1');
    root.innerHTML = \`
<style>
  #opensecant-recorder-overlay {
    all: initial;
    position: fixed !important;
    right: 16px !important;
    bottom: 16px !important;
    z-index: 2147483646 !important;
    font-family: ui-sans-serif, system-ui, Segoe UI, sans-serif !important;
    color: #e8eef7 !important;
    width: 320px !important;
    max-height: 70vh !important;
    display: flex !important;
    flex-direction: column !important;
    box-shadow: 0 12px 40px rgba(0,0,0,.45) !important;
    border-radius: 12px !important;
    overflow: hidden !important;
    border: 1px solid rgba(255,255,255,.12) !important;
    background: linear-gradient(160deg, #1a2332 0%, #121820 100%) !important;
  }
  #opensecant-recorder-overlay * { box-sizing: border-box; font-family: inherit; }
  #osr-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; background: rgba(255,255,255,.04);
    border-bottom: 1px solid rgba(255,255,255,.08);
  }
  #osr-title { font-size: 13px; font-weight: 700; letter-spacing: .02em; color: #9fd3ff; }
  #osr-status {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    background: #7a5b12; color: #ffe7a0;
  }
  #osr-status.rec { background: #1f6f43; color: #c8f7d8; }
  #osr-status.paused { background: #7a5b12; color: #ffe7a0; }
  #osr-status.stopped { background: #5a2a2a; color: #ffc9c9; }
  #osr-actions { display: flex; gap: 6px; padding: 10px 12px; }
  #osr-actions button {
    flex: 1; border: 0; border-radius: 8px; padding: 8px 6px;
    font-size: 12px; font-weight: 600; cursor: pointer; color: #0b1220;
  }
  #osr-pause { background: #3dd68c; }
  #osr-stop { background: #ff6b6b; color: #fff; }
  #osr-undo { background: #7aa2ff; color: #0b1220; }
  #osr-list {
    list-style: none; margin: 0; padding: 0 10px 12px;
    overflow: auto; max-height: 42vh;
  }
  #osr-list li {
    font-size: 11px; line-height: 1.35; padding: 7px 8px; margin-top: 6px;
    background: rgba(255,255,255,.05); border-radius: 8px;
    border-left: 3px solid #4da3ff; color: #d7e3f4;
  }
  #osr-list li .osr-idx { color: #7aa2ff; font-weight: 700; margin-right: 4px; }
  #osr-hint { font-size: 10px; color: #8aa0b8; padding: 0 12px 10px; }
</style>
<div id="osr-header">
  <span id="osr-title">OpenSecant Recorder</span>
  <span id="osr-status" class="paused">READY</span>
</div>
<div id="osr-actions">
  <button type="button" id="osr-pause">Start</button>
  <button type="button" id="osr-undo">Undo</button>
  <button type="button" id="osr-stop">Stop & Save</button>
</div>
<ul id="osr-list"></ul>
<div id="osr-hint">Click Start, then use the page. Site auto-clicks are ignored.</div>
\`;
    document.documentElement.appendChild(root);

    root.querySelector('#osr-pause').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const st = root.querySelector('#osr-status');
      const btn = root.querySelector('#osr-pause');
      const hint = root.querySelector('#osr-hint');

      if (!STATE.started) {
        STATE.started = true;
        STATE.recording = true;
        STATE.paused = false;
        st.textContent = 'REC';
        st.className = 'rec';
        btn.textContent = 'Pause';
        btn.style.background = '#f0c14b';
        if (hint) hint.textContent = 'Recording… Pause anytime. Stop & Save when done.';
        persistRecState();
        send({ kind: 'status', status: 'recording' });
        return;
      }

      STATE.paused = !STATE.paused;
      if (STATE.paused) {
        flushFill();
        st.textContent = 'PAUSED';
        st.className = 'paused';
        btn.textContent = 'Resume';
        btn.style.background = '#3dd68c';
        persistRecState();
        send({ kind: 'status', status: 'paused' });
      } else {
        st.textContent = 'REC';
        st.className = 'rec';
        btn.textContent = 'Pause';
        btn.style.background = '#f0c14b';
        persistRecState();
        send({ kind: 'status', status: 'recording' });
      }
    });

    root.querySelector('#osr-undo').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (STATE.steps.length === 0) return;
      STATE.steps.pop();
      renderSteps();
      send({ kind: 'undo' });
    });

    root.querySelector('#osr-stop').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      flushFill();
      STATE.recording = false;
      STATE.paused = true;
      STATE.started = false;
      persistRecState();
      const st = root.querySelector('#osr-status');
      st.textContent = 'STOPPED';
      st.className = 'stopped';
      send({ kind: 'stop', steps: STATE.steps.slice() });
    });

    // Restore button chrome after navigation if already recording
    if (STATE.started) {
      const st = root.querySelector('#osr-status');
      const btn = root.querySelector('#osr-pause');
      const hint = root.querySelector('#osr-hint');
      if (STATE.paused) {
        st.textContent = 'PAUSED';
        st.className = 'paused';
        btn.textContent = 'Resume';
        btn.style.background = '#3dd68c';
      } else {
        st.textContent = 'REC';
        st.className = 'rec';
        btn.textContent = 'Pause';
        btn.style.background = '#f0c14b';
      }
      if (hint) hint.textContent = 'Recording… Pause anytime. Stop & Save when done.';
    }
  }

  function renderSteps() {
    const list = document.querySelector('#osr-list');
    if (!list) return;
    list.innerHTML = '';
    STATE.steps.forEach((s, i) => {
      const li = document.createElement('li');
      let label = s.type;
      if (s.type === 'navigate') label = 'open ' + truncate(s.url, 48);
      else if (s.type === 'fill') label = 'fill → ' + truncate(s.value, 36);
      else if (s.type === 'press') label = 'press ' + (s.key || 'Enter');
      else if (s.type === 'click') {
        const t = s.target || {};
        label = 'click → ' + truncate(t.attributes && t.attributes['aria-label'] || t.labelText || t.text || t.tag, 40);
      } else if (s.type === 'select') label = 'select → ' + truncate(s.value, 36);
      else if (s.type === 'check' || s.type === 'uncheck') {
        const t = s.target || {};
        label = s.type + ' → ' + truncate(t.labelText || t.text || t.tag, 36);
      }
      li.innerHTML = '<span class="osr-idx">' + (i + 1) + '.</span> ' + label;
      list.appendChild(li);
    });
    list.scrollTop = list.scrollHeight;
  }

  function boot() {
    ensureOverlay();
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusout', onBlur, true);
    setInterval(checkNavigation, 500);
    send({ kind: 'ready', url: location.href });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-inject overlay after SPA navigations that wipe body
  const mo = new MutationObserver(() => {
    if (!document.getElementById(OVERLAY_ID)) ensureOverlay();
  });
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();`;
}

module.exports = { getRecorderInjectSource };

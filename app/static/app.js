let pets = [], activePet = null, selectedCrops = new Map(), refsItems = [], negIds = [], immichUrl = 'http://localhost:2283', negCandidateMode = false, borderlineMode = false, scanLowConfMode = false, scanDiscoverMode = false, lastClickedKey = null, negGeneration = 0, negPollTimer = null, blGeneration = 0, blPollTimer = null;
let lastScanResult = {};
const manualBboxOverrides = new Map();
let modelsPollTimer = null;
let modelNotReadyPolls = 0;
let inspectState = {
  assetId: null,
  payload: {},
  drawActive: false,
  drawing: false,
  startX: 0,
  startY: 0,
  tempBox: null,
  editorInit: false,
  editMode: null,
  editStartX: 0,
  editStartY: 0,
  editStartClientX: 0,
  editStartClientY: 0,
  editStartBox: null,
  editPrevBox: null,
  pointerId: null,
  gestureMoved: false,
  imageViewport: null,
  navButtons: [],
  navIndex: -1,
  pendingRefAdd: null,
};

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!r.ok) { const t = await r.text().catch(() => r.statusText); throw new Error(t); }
  return r.json();
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t); el._t = setTimeout(() => el.className = 'toast', 4000);
}

function initials(name) { return name.slice(0, 2).toUpperCase(); }

function setPhotoGridGrouped(grouped) {
  const grid = document.getElementById('photoGrid');
  if (!grid) return;
  grid.classList.toggle('grouped', !!grouped);
}

function stopModelsPolling() {
  if (!modelsPollTimer) return;
  clearInterval(modelsPollTimer);
  modelsPollTimer = null;
}

function updateModelsBanner(cfg) {
  const yoloModel = cfg.yolo_model || 'YOLO model';
  const banner = document.getElementById('modelsBanner');
  if (!banner) return;

  if (cfg.models_ready) {
    modelNotReadyPolls = 0;
    banner.classList.remove('visible');
    stopModelsPolling();
    return;
  }

  modelNotReadyPolls += 1;
  const hasError = !!cfg.models_error;
  const filesPresent = !!cfg.model_files_present;

  // Avoid flashing the warning during normal startup when files are already cached.
  if (!hasError && filesPresent && modelNotReadyPolls < 4) {
    banner.classList.remove('visible');
    return;
  }

  if (hasError) {
    banner.innerHTML = `<strong>Models failed to load.</strong> ${cfg.models_error}`;
  } else if (filesPresent) {
    banner.innerHTML = `<strong>Models initializing…</strong> Model files are present; waiting for workers to finish loading.`;
  } else {
    banner.innerHTML = `<strong>Models not ready.</strong> On first start, ${yoloModel} (~6 MB) and the CLIP model (~350 MB) are downloaded. Ensure the container has internet access. This notice will disappear automatically once models are ready.`;
  }
  banner.classList.add('visible');
}

function ensureModelsPolling() {
  if (modelsPollTimer) return;
  modelsPollTimer = setInterval(async () => {
    try {
      const cfg = await api('/api/config');
      updateModelsBanner(cfg);
    } catch (_) {
      // Keep existing banner state if polling transiently fails.
    }
  }, 3000);
}

function renderOpenInspectButton(assetId, payload = {}) {
  const encoded = encodeURIComponent(JSON.stringify(payload || {}));
  return `<button type="button" class="photo-open" data-asset-id="${assetId}" data-inspect="${encoded}" title="Inspect detection" aria-label="Inspect detection" onclick="openAssetInspect(event,'${assetId}','${encoded}')">⤢</button>`;
}

function _getInspectNavButtons() {
  return [...document.querySelectorAll('#photoGrid .photo-open')];
}

function _updateInspectNavUI() {
  const prevBtn = document.getElementById('inspectPrevBtn');
  const nextBtn = document.getElementById('inspectNextBtn');
  if (!prevBtn || !nextBtn) return;
  const n = inspectState.navButtons ? inspectState.navButtons.length : 0;
  const idx = inspectState.navIndex;
  prevBtn.disabled = !(n > 1 && idx > 0);
  nextBtn.disabled = !(n > 1 && idx >= 0 && idx < n - 1);
}

function _setInspectNavigation(originButton = null, explicitIndex = null) {
  const buttons = _getInspectNavButtons();
  inspectState.navButtons = buttons;
  if (!buttons.length) {
    inspectState.navIndex = -1;
    _updateInspectNavUI();
    return;
  }
  if (typeof explicitIndex === 'number' && explicitIndex >= 0 && explicitIndex < buttons.length) {
    inspectState.navIndex = explicitIndex;
    _updateInspectNavUI();
    return;
  }
  if (originButton) {
    const idx = buttons.indexOf(originButton);
    inspectState.navIndex = idx >= 0 ? idx : -1;
    _updateInspectNavUI();
    return;
  }
  const aid = inspectState.assetId;
  inspectState.navIndex = buttons.findIndex((b) => b.dataset.assetId === aid);
  _updateInspectNavUI();
}

function navigateInspect(delta) {
  let buttons = inspectState.navButtons || [];
  if (!buttons.length) {
    buttons = _getInspectNavButtons();
    inspectState.navButtons = buttons;
  }
  if (!buttons.length) return;

  let idx = inspectState.navIndex;
  if (idx < 0 || idx >= buttons.length) {
    idx = buttons.findIndex((b) => b.dataset.assetId === inspectState.assetId);
    if (idx < 0) idx = 0;
  }

  const next = idx + delta;
  if (next < 0 || next >= buttons.length) return;

  const btn = buttons[next];
  inspectState.navIndex = next;
  _updateInspectNavUI();
  openAssetInspect(null, btn.dataset.assetId || '', btn.dataset.inspect || '', next);
}

function _releaseInspectPointerCapture() {
  const pid = inspectState.pointerId;
  if (pid == null) return;
  const box = document.getElementById('inspectBbox');
  const wrap = document.querySelector('#inspectModal .inspect-image-wrap');
  for (const el of [box, wrap]) {
    if (!el || typeof el.hasPointerCapture !== 'function' || typeof el.releasePointerCapture !== 'function') continue;
    try {
      if (el.hasPointerCapture(pid)) el.releasePointerCapture(pid);
    } catch (_) {
      // Capture may already be released by the browser.
    }
  }
}

async function closeInspectModal() {
  if (inspectState.pendingRefAdd) {
    const pending = inspectState.pendingRefAdd;
    const bbox = getEffectiveBoxForAsset(pending.assetId, inspectState.payload);
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(v => Number.isFinite(v))) {
      toast('Draw or adjust a bbox, then click Save', 'error');
      return;
    }
    try {
      const existing = await api(`/api/pets/${encodeURIComponent(pending.petName)}/assets`);
      const existingCrops = existing.assets.map(a => ({ asset_id: a.id, crop_idx: a.crop_idx, bbox: a.bbox }));
      const newCrop = { asset_id: pending.assetId, crop_idx: pending.cropIdx, bbox };
      const seen = new Set();
      const merged = [...existingCrops, newCrop].filter(c => {
        const k = c.crop_idx != null ? `${c.asset_id}_${c.crop_idx}` : c.asset_id;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      await api(`/api/pets/${encodeURIComponent(pending.petName)}/assets`, { method: 'POST', body: { assets: merged } });
      if (activePet?.name === pending.petName) await loadRefs(pending.petName);
      await refreshState();
      toast(`Added to ${pending.petName}`, 'success');
    } catch (e) {
      toast('Error: ' + e.message, 'error');
      return;
    }
  }

  _releaseInspectPointerCapture();
  stopInspectDraw();
  inspectState.tempBox = null;
  inspectState.editMode = null;
  inspectState.editStartBox = null;
  inspectState.pendingRefAdd = null;
  inspectState.navButtons = [];
  inspectState.navIndex = -1;
  _updateInspectNavUI();
  const box = document.getElementById('inspectBbox');
  if (box) box.style.display = 'none';
  document.getElementById('inspectModal').classList.remove('open');
}

function getEffectiveBoxForAsset(assetId, payload = {}) {
  if (manualBboxOverrides.has(assetId)) return manualBboxOverrides.get(assetId);
  return Array.isArray(payload.bbox) ? payload.bbox : null;
}

function _clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function _boxFromBbox(bbox) {
  if (!bbox || bbox.length !== 4 || !bbox.every(v => Number.isFinite(v))) return null;
  const x1 = _clamp01(bbox[0]);
  const y1 = _clamp01(bbox[1]);
  const x2 = _clamp01(bbox[2]);
  const y2 = _clamp01(bbox[3]);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function _bboxFromBox(box) {
  if (!box) return null;
  return [box.x, box.y, box.x + box.w, box.y + box.h].map(_clamp01);
}

function _computeInspectImageViewport() {
  const wrap = document.querySelector('#inspectModal .inspect-image-wrap');
  const img = document.getElementById('inspectImage');
  if (!wrap || !img) return null;

  const ww = wrap.clientWidth;
  const wh = wrap.clientHeight;
  const iw = img.naturalWidth || 0;
  const ih = img.naturalHeight || 0;
  if (!ww || !wh || !iw || !ih) return null;

  const wrapRatio = ww / wh;
  const imgRatio = iw / ih;
  let drawW = ww;
  let drawH = wh;
  let left = 0;
  let top = 0;

  if (imgRatio > wrapRatio) {
    drawW = ww;
    drawH = ww / imgRatio;
    top = (wh - drawH) / 2;
  } else {
    drawH = wh;
    drawW = wh * imgRatio;
    left = (ww - drawW) / 2;
  }

  return { left, top, width: drawW, height: drawH };
}

function _updateInspectViewport() {
  inspectState.imageViewport = _computeInspectImageViewport();
}

function updateInspectBoxUI(assetId, payload = {}) {
  const box = document.getElementById('inspectBbox');
  const vp = inspectState.imageViewport;
  const bbox = inspectState.tempBox
    ? _bboxFromBox(inspectState.tempBox)
    : getEffectiveBoxForAsset(assetId, payload);
  if (bbox && bbox.length === 4 && bbox.every(v => Number.isFinite(v))) {
    const [x1, y1, x2, y2] = bbox;
    const leftPct = Math.max(0, Math.min(1, x1));
    const topPct = Math.max(0, Math.min(1, y1));
    const widthPct = Math.max(0, Math.min(1, x2) - Math.max(0, Math.min(1, x1)));
    const heightPct = Math.max(0, Math.min(1, y2) - Math.max(0, Math.min(1, y1)));
    box.style.display = '';
    if (vp) {
      box.style.left = `${vp.left + leftPct * vp.width}px`;
      box.style.top = `${vp.top + topPct * vp.height}px`;
      box.style.width = `${widthPct * vp.width}px`;
      box.style.height = `${heightPct * vp.height}px`;
    } else {
      box.style.left = `${leftPct * 100}%`;
      box.style.top = `${topPct * 100}%`;
      box.style.width = `${widthPct * 100}%`;
      box.style.height = `${heightPct * 100}%`;
    }
  } else {
    box.style.display = 'none';
  }
}

function _getInspectWrapNormPoint(ev) {
  const wrap = document.querySelector('#inspectModal .inspect-image-wrap');
  if (!wrap) return { x: 0, y: 0 };
  const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return { x: 0, y: 0 };

  const vp = inspectState.imageViewport || { left: 0, top: 0, width: r.width, height: r.height };
  if (!vp.width || !vp.height) return { x: 0, y: 0 };

  const relX = ev.clientX - r.left - vp.left;
  const relY = ev.clientY - r.top - vp.top;
  const x = _clamp01(relX / vp.width);
  const y = _clamp01(relY / vp.height);
  return { x, y };
}

function _applyInspectEdit(mode, box, dx, dy) {
  const minSize = 0.01;
  let x1 = box.x;
  let y1 = box.y;
  let x2 = box.x + box.w;
  let y2 = box.y + box.h;

  if (mode === 'move') {
    const nx = _clamp01(box.x + dx);
    const ny = _clamp01(box.y + dy);
    x1 = Math.min(nx, 1 - box.w);
    y1 = Math.min(ny, 1 - box.h);
    x2 = x1 + box.w;
    y2 = y1 + box.h;
  } else {
    if (mode.includes('w')) x1 = _clamp01(x1 + dx);
    if (mode.includes('e')) x2 = _clamp01(x2 + dx);
    if (mode.includes('n')) y1 = _clamp01(y1 + dy);
    if (mode.includes('s')) y2 = _clamp01(y2 + dy);

    if (x2 - x1 < minSize) {
      if (mode.includes('w')) x1 = Math.max(0, x2 - minSize);
      else x2 = Math.min(1, x1 + minSize);
    }
    if (y2 - y1 < minSize) {
      if (mode.includes('n')) y1 = Math.max(0, y2 - minSize);
      else y2 = Math.min(1, y1 + minSize);
    }
  }

  return {
    x: _clamp01(Math.min(x1, x2)),
    y: _clamp01(Math.min(y1, y2)),
    w: _clamp01(Math.abs(x2 - x1)),
    h: _clamp01(Math.abs(y2 - y1)),
  };
}

function _commitInspectTempBox() {
  if (!inspectState.assetId || !inspectState.tempBox) return;
  const bbox = _bboxFromBox(inspectState.tempBox);
  manualBboxOverrides.set(inspectState.assetId, bbox);
  inspectState.payload = { ...(inspectState.payload || {}), bbox };
  updateInspectBoxUI(inspectState.assetId, inspectState.payload);
}

function _ensureInspectHandles() {
  const box = document.getElementById('inspectBbox');
  if (!box || box.dataset.handlesReady === '1') return;
  const handles = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
  box.innerHTML = handles.map(h => `<span class="inspect-handle inspect-handle-${h}" data-edge="${h}"></span>`).join('');
  box.dataset.handlesReady = '1';
}

function _initInspectEditor() {
  if (inspectState.editorInit) return;
  const wrap = document.querySelector('#inspectModal .inspect-image-wrap');
  const box = document.getElementById('inspectBbox');
  const img = document.getElementById('inspectImage');
  if (!wrap || !box) return;

  _ensureInspectHandles();
  _updateInspectViewport();

  if (img) {
    img.addEventListener('load', () => {
      _updateInspectViewport();
      if (inspectState.assetId) updateInspectBoxUI(inspectState.assetId, inspectState.payload);
    });
  }

  window.addEventListener('resize', () => {
    _updateInspectViewport();
    if (inspectState.assetId) updateInspectBoxUI(inspectState.assetId, inspectState.payload);
  });

  box.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (!inspectState.tempBox) return;
    ev.preventDefault();
    ev.stopPropagation();
    const p = _getInspectWrapNormPoint(ev);
    inspectState.pointerId = ev.pointerId;
    inspectState.editMode = ev.target?.dataset?.edge || 'move';
    inspectState.editStartX = p.x;
    inspectState.editStartY = p.y;
    inspectState.editStartClientX = ev.clientX;
    inspectState.editStartClientY = ev.clientY;
    inspectState.gestureMoved = false;
    inspectState.editPrevBox = inspectState.tempBox ? { ...inspectState.tempBox } : null;
    inspectState.editStartBox = { ...inspectState.tempBox };
    box.setPointerCapture(ev.pointerId);
  });

  wrap.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('#inspectBbox')) return;
    if (ev.target.closest('.inspect-nav-overlay')) return;
    ev.preventDefault();
    const p = _getInspectWrapNormPoint(ev);
    inspectState.pointerId = ev.pointerId;
    inspectState.editPrevBox = inspectState.tempBox ? { ...inspectState.tempBox } : null;
    inspectState.editMode = 'draw';
    inspectState.editStartX = p.x;
    inspectState.editStartY = p.y;
    inspectState.editStartClientX = ev.clientX;
    inspectState.editStartClientY = ev.clientY;
    inspectState.gestureMoved = false;
    inspectState.tempBox = { x: p.x, y: p.y, w: 0.001, h: 0.001 };
    inspectState.editStartBox = { ...inspectState.tempBox };
    updateInspectBoxUI(inspectState.assetId, inspectState.payload);
    wrap.setPointerCapture(ev.pointerId);
  });

  window.addEventListener('pointermove', (ev) => {
    if (!inspectState.editMode) return;
    if (inspectState.pointerId !== null && ev.pointerId !== inspectState.pointerId) return;
    const p = _getInspectWrapNormPoint(ev);
    const dx = p.x - inspectState.editStartX;
    const dy = p.y - inspectState.editStartY;
    if (!inspectState.gestureMoved) {
      const movedPx = Math.hypot(ev.clientX - inspectState.editStartClientX, ev.clientY - inspectState.editStartClientY);
      if (movedPx > 2) inspectState.gestureMoved = true;
    }
    if (inspectState.editMode === 'draw') {
      inspectState.tempBox = {
        x: Math.min(inspectState.editStartX, p.x),
        y: Math.min(inspectState.editStartY, p.y),
        w: Math.max(0.001, Math.abs(p.x - inspectState.editStartX)),
        h: Math.max(0.001, Math.abs(p.y - inspectState.editStartY)),
      };
    } else if (inspectState.editStartBox) {
      inspectState.tempBox = _applyInspectEdit(inspectState.editMode, inspectState.editStartBox, dx, dy);
    }
    updateInspectBoxUI(inspectState.assetId, inspectState.payload);
  });

  window.addEventListener('pointerup', (ev) => {
    if (!inspectState.editMode) return;
    if (inspectState.pointerId !== null && ev.pointerId !== inspectState.pointerId) return;
    const tooSmall = inspectState.tempBox && (inspectState.tempBox.w < 0.01 || inspectState.tempBox.h < 0.01);
    if (!inspectState.gestureMoved || tooSmall) {
      // Treat click-without-drag as a no-op and keep the previous box.
      inspectState.tempBox = inspectState.editPrevBox ? { ...inspectState.editPrevBox } : null;
      updateInspectBoxUI(inspectState.assetId, inspectState.payload);
    } else {
      _commitInspectTempBox();
    }
    inspectState.editMode = null;
    inspectState.editStartBox = null;
    inspectState.editPrevBox = null;
    _releaseInspectPointerCapture();
    inspectState.pointerId = null;
    inspectState.gestureMoved = false;
  });

  window.addEventListener('pointercancel', () => {
    inspectState.editMode = null;
    inspectState.editStartBox = null;
    inspectState.editPrevBox = null;
    _releaseInspectPointerCapture();
    inspectState.pointerId = null;
    inspectState.gestureMoved = false;
  });

  inspectState.editorInit = true;
}

function stopInspectDraw() {
  _releaseInspectPointerCapture();
  const canvas = document.getElementById('inspectCanvas');
  if (!canvas) return;
  canvas.style.display = 'none';
  canvas.onmousedown = null;
  canvas.onmousemove = null;
  canvas.onmouseup = null;
  canvas.onmouseleave = null;
  inspectState.drawActive = false;
  inspectState.drawing = false;
  inspectState.editMode = null;
  inspectState.editStartBox = null;
  inspectState.editPrevBox = null;
  inspectState.pointerId = null;
  inspectState.gestureMoved = false;
}

function startInspectDraw() {
  // Kept as a no-op for backwards compatibility with existing onclick bindings.
  _initInspectEditor();
}

function saveInspectBox() {
  if (!inspectState.assetId) return;
  if (!inspectState.tempBox) inspectState.tempBox = _boxFromBbox(getEffectiveBoxForAsset(inspectState.assetId, inspectState.payload));
  _commitInspectTempBox();
  toast('Manual box saved', 'success');
}

function clearInspectBox() {
  if (!inspectState.assetId) return;
  manualBboxOverrides.set(inspectState.assetId, null);
  inspectState.payload = { ...(inspectState.payload || {}), bbox: null };
  inspectState.tempBox = null;
  updateInspectBoxUI(inspectState.assetId, inspectState.payload);
  toast('Using fallback box for this asset', 'success');
}

function _setInspectActionStatus(msg = '', type = '') {
  const el = document.getElementById('inspectActionStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--danger)' : (type === 'success' ? 'var(--success)' : 'var(--text2)');
}

function _populateInspectPetSelect() {
  const sel = document.getElementById('inspectPetSelect');
  if (!sel) return;
  const options = ['<option value="">Select pet…</option>', ...pets.map(p => `<option value="${p.name}">${p.name}</option>`)];
  sel.innerHTML = options.join('');
  const activeName = (activePet?.name || '').trim();
  const proposed = (inspectState.payload?.pet_name || '').trim();
  if (activeName && pets.some(p => p.name === activeName)) {
    sel.value = activeName;
    return;
  }
  if (proposed && pets.some(p => p.name === proposed)) {
    sel.value = proposed;
    return;
  }
  if (pets.length) {
    sel.value = pets[0].name;
  }
}

function _getInspectActionPet() {
  const sel = document.getElementById('inspectPetSelect');
  return (sel && sel.value) ? sel.value : '';
}

function _getInspectActionBbox() {
  const aid = inspectState.assetId;
  if (!aid) return null;
  const bbox = getEffectiveBoxForAsset(aid, inspectState.payload);
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(v => Number.isFinite(v))) {
    // Default to full image bbox for user-driven tagging
    return [0, 0, 1, 1];
  }
  return bbox;
}

function _resolveInspectPotentialLabel(payload = {}) {
  const guessedPet = (payload.pet_name || '').trim();
  if (guessedPet) {
    const prob = Number(payload.prob);
    const score = Number.isFinite(prob) ? ` (${Math.round(prob * 100)}%)` : '';
    return `Potential: ${guessedPet}${score}`;
  }
  return 'Potential: not available';
}

async function _upsertSingleRef(petName, assetId, cropIdx, bbox) {
  const existing = await api(`/api/pets/${encodeURIComponent(petName)}/assets`);
  const existingCrops = existing.assets.map(a => ({ asset_id: a.id, crop_idx: a.crop_idx, bbox: a.bbox }));
  const newCrop = { asset_id: assetId, crop_idx: cropIdx ?? null, bbox: bbox ?? null };
  const seen = new Set();
  const merged = [...existingCrops, newCrop].filter(c => {
    const k = c.crop_idx != null ? `${c.asset_id}_${c.crop_idx}` : c.asset_id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return api(`/api/pets/${encodeURIComponent(petName)}/assets`, { method: 'POST', body: { assets: merged } });
}

async function inspectAddRefAsset() {
  const assetId = inspectState.assetId;
  const petName = _getInspectActionPet();
  const bbox = _getInspectActionBbox();
  if (!assetId) return;
  if (!petName) { _setInspectActionStatus('Choose a pet first.', 'error'); return; }
  if (!bbox) { _setInspectActionStatus('Bbox is required. Draw or adjust the box first.', 'error'); return; }
  try {
    await _upsertSingleRef(petName, assetId, inspectState.payload?.crop_idx ?? null, bbox);
    if (activePet?.name === petName) await loadRefs(petName);
    await refreshState();
    advanceInspectAfterAction(assetId);
    _setInspectActionStatus(`Added as reference for ${petName}.`, 'success');
    toast(`Added to ${petName}`, 'success');
  } catch (e) {
    _setInspectActionStatus(`Add ref failed: ${e.message}`, 'error');
  }
}

async function inspectTagAsset() {
  const assetId = inspectState.assetId;
  const petName = _getInspectActionPet();
  const bbox = _getInspectActionBbox();
  if (!assetId) return;
  if (!petName) { _setInspectActionStatus('Choose a pet first.', 'error'); return; }
  try {
    const r = await api('/api/scan/tag', {
      method: 'POST',
      body: { asset_ids: [assetId], pet_name: petName, use_match: false, bboxes: { [assetId]: bbox } },
    });
    if (!r.failed && ((r.tagged || 0) + (r.already_tagged || 0) > 0)) {
      markAssetsAsTagged([assetId]);
      advanceInspectAfterAction(assetId);
    }
    _setInspectActionStatus(`Tagged ${r.tagged}, already tagged ${r.already_tagged}, no bbox ${r.skipped_no_bbox || 0}, failed ${r.failed}.`, r.failed ? 'error' : 'success');
    toast(`Tagged as ${petName}: ${r.tagged}`, r.failed ? 'error' : 'success');
  } catch (e) {
    _setInspectActionStatus(`Tag failed: ${e.message}`, 'error');
  }
}

async function inspectTagAndRefAsset() {
  const assetId = inspectState.assetId;
  const petName = _getInspectActionPet();
  const bbox = _getInspectActionBbox();
  if (!assetId) return;
  if (!petName) { _setInspectActionStatus('Choose a pet first.', 'error'); return; }
  try {
    const tag = await api('/api/scan/tag', {
      method: 'POST',
      body: { asset_ids: [assetId], pet_name: petName, use_match: false, bboxes: { [assetId]: bbox } },
    });
    if (!tag.failed && ((tag.tagged || 0) + (tag.already_tagged || 0) > 0)) {
      markAssetsAsTagged([assetId]);
    }
    await _upsertSingleRef(petName, assetId, inspectState.payload?.crop_idx ?? null, bbox);
    if (activePet?.name === petName) await loadRefs(petName);
    await refreshState();
    advanceInspectAfterAction(assetId);
    _setInspectActionStatus(`Tagged ${tag.tagged} and referenced for ${petName}.`, tag.failed ? 'error' : 'success');
    toast(`Tag + ref for ${petName} complete`, tag.failed ? 'error' : 'success');
  } catch (e) {
    _setInspectActionStatus(`Tag + ref failed: ${e.message}`, 'error');
  }
}

async function inspectIgnoreAsset() {
  const assetId = inspectState.assetId;
  const petName = _getInspectActionPet() || activePet?.name || inspectState.payload?.pet_name || '';
  if (!assetId) return;
  if (!petName) { _setInspectActionStatus('Choose a pet to apply ignore.', 'error'); return; }
  try {
    await api('/api/skipped', { method: 'POST', body: { asset_ids: [assetId], pet_name: petName } });
    advanceInspectAfterAction(assetId);
    _setInspectActionStatus(`Ignored for ${petName}.`, 'success');
    toast(`Ignored for ${petName}`, 'success');
  } catch (e) {
    _setInspectActionStatus(`Ignore failed: ${e.message}`, 'error');
  }
}

async function inspectSkipAsRefAsset() {
  const assetId = inspectState.assetId;
  const petName = _getInspectActionPet() || activePet?.name || inspectState.payload?.pet_name || '';
  if (!assetId) return;
  if (!petName) { _setInspectActionStatus('Choose a pet to skip as reference.', 'error'); return; }
  try {
    await api('/api/skip-as-ref', { method: 'POST', body: { asset_ids: [assetId], pet_name: petName } });
    advanceInspectAfterAction(assetId);
    _setInspectActionStatus(`Skipped as reference for ${petName}.`, 'success');
    toast(`Skipped as reference for ${petName}`, 'success');
  } catch (e) {
    _setInspectActionStatus(`Skip as reference failed: ${e.message}`, 'error');
  }
}

async function inspectNotPetAsset() {
  const assetId = inspectState.assetId;
  if (!assetId) return;
  try {
    await api('/api/negatives', { method: 'POST', body: { asset_ids: [assetId] } });
    await loadNegatives();
    advanceInspectAfterAction(assetId);
    _setInspectActionStatus('Added to "not a pet".', 'success');
    toast('Added to "not a pet"', 'success');
  } catch (e) {
    _setInspectActionStatus(`Not a pet failed: ${e.message}`, 'error');
  }
}

function openAddByIdInspect(assetId, payload, petName, cropIdx = null) {
  inspectState.pendingRefAdd = { assetId, petName, cropIdx };
  const encoded = encodeURIComponent(JSON.stringify(payload || {}));
  openAssetInspect(null, assetId, encoded, null);
}

function openAssetInspect(event, assetId, encodedPayload = '', navIndex = null) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  let payload = {};
  try {
    payload = encodedPayload ? JSON.parse(decodeURIComponent(encodedPayload)) : {};
  } catch (_) {
    payload = {};
  }

  window.__inspectAssetId = assetId;
  inspectState.assetId = assetId;
  inspectState.payload = payload;
  inspectState.tempBox = _boxFromBbox(getEffectiveBoxForAsset(assetId, payload));
  const originBtn = event && event.target && typeof event.target.closest === 'function'
    ? event.target.closest('.photo-open')
    : null;
  _setInspectNavigation(originBtn, navIndex);
  const img = document.getElementById('inspectImage');
  const meta = document.getElementById('inspectMeta');
  const openImmich = document.getElementById('inspectOpenImmich');
  const potentialLabel = document.getElementById('inspectPotentialLabel');

  img.src = `/api/asset-full/${assetId}`;
  openImmich.href = `${immichUrl}/photos/${assetId}`;
  if (potentialLabel) potentialLabel.textContent = _resolveInspectPotentialLabel(payload);
  _populateInspectPetSelect();
  _setInspectActionStatus('');

  _updateInspectViewport();
  updateInspectBoxUI(assetId, payload);
  _initInspectEditor();

  const score = payload.prob != null ? `${Math.round(Number(payload.prob) * 100)}%` : 'N/A';
  const effBox = getEffectiveBoxForAsset(assetId, payload);
  let area = 'N/A';
  if (effBox) {
    const areaPct = Math.max(0, (effBox[2] - effBox[0]) * (effBox[3] - effBox[1])) * 100;
    area = `${areaPct.toFixed(2)}%`;
  }
  meta.innerHTML = [
    `<div class="inspect-meta-item"><span>Asset</span><strong>${assetId}</strong></div>`,
    `<div class="inspect-meta-item"><span>Pet guess</span><strong>${payload.pet_name || 'N/A'}</strong></div>`,
    `<div class="inspect-meta-item"><span>Confidence</span><strong>${score}</strong></div>`,
    `<div class="inspect-meta-item"><span>Date</span><strong>${payload.date ? fmtDate(payload.date) : 'N/A'}</strong></div>`,
    `<div class="inspect-meta-item"><span>Box area</span><strong>${area}</strong></div>`,
    `<div class="inspect-meta-item"><span>Detection</span><strong>${effBox ? 'Box rendered' : 'No box available'}</strong></div>`
  ].join('');

  document.getElementById('inspectModal').classList.add('open');
}

async function refreshState() {
  try {
    const cfg = await api('/api/config');
    immichUrl = cfg.immich_external_url.replace(/\/$/, '');
    updateModelsBanner(cfg);
    if (!cfg.models_ready) ensureModelsPolling();
  } catch(e) {}
  await loadPets();
  loadNegatives();
}

// ---------------------------------------------------------------------------
// Pets
// ---------------------------------------------------------------------------

async function loadPets(keepActive = false) {
  try {
    const d = await api('/api/pets');
    pets = d.pets;
    if (activePet) {
      activePet = pets.find(p => p.name === activePet.name) || activePet;
    }
    renderSidebar();
    updateNegStatus();
  } catch(e) { toast('Could not load pets: ' + e.message, 'error'); }
}

function renderSidebar() {
  const el = document.getElementById('petsList');
  if (!pets.length) {
    el.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text3);text-align:center;line-height:1.6;">No pets yet.<br>Add one to get started.</div>';
    renderScanPetSelect();
    showGuide();
    document.getElementById('refsTitle').textContent = 'No pet selected';
    document.getElementById('findRefsBtn').style.display = 'none';
    document.getElementById('addByIdBtn').style.display = 'none';
    document.getElementById('clearRefsBtn').style.display = 'none';
    document.getElementById('viewSkippedBtn').style.display = 'none';
    document.getElementById('viewSkipAsRefBtn').style.display = 'none';
    document.getElementById('refsGrid').innerHTML = '<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-sub">Add a pet first</div></div>';
    return;
  }
  el.innerHTML = pets.map(p => `
    <div class="pet-item ${activePet?.name === p.name ? 'active' : ''}" onclick="selectPet('${p.name}')">
      <div class="pet-avatar">${p.person_id ? `<img src="/api/person-thumb/${p.person_id}" onerror="this.parentElement.textContent='${initials(p.name)}'" alt="">` : initials(p.name)}</div>
      <div class="pet-info">
        <div class="pet-name">${p.name}</div>
        <div class="pet-count">${p.ref_count} ref${p.ref_count !== 1 ? 's' : ''}</div>
      </div>
      <button class="pet-edit" onclick="event.stopPropagation(); openEditPet('${p.name}')" title="Edit">✎</button>
      <button class="pet-delete" onclick="event.stopPropagation(); openDeletePet('${p.name}')" title="Delete">✕</button>
    </div>`).join('');
  renderScanPetSelect();
}

function renderScanPetSelect() {
  const el = document.getElementById('scanPetSelect');
  if (!el) return;
  const previous = el.value;
  const isValidPrevious = pets.some(p => p.name === previous);
  const fallback = activePet && pets.some(p => p.name === activePet.name) ? activePet.name : '';
  const selected = isValidPrevious ? previous : fallback;
  el.innerHTML = ['<option value="">All pets</option>', ...pets.map(p => `<option value="${p.name}">${p.name}</option>`)].join('');
  el.value = selected;
}

function showGuide() {
  scanDiscoverMode = false;
  setPhotoGridGrouped(false);
  document.getElementById('resultsLabel').textContent = '';
  document.getElementById('photoGrid').innerHTML = `<div class="guide" style="grid-column:1/-1">
    <div class="guide-steps">
      <div class="guide-step"><div class="guide-step-num">1</div><div class="guide-step-body"><div class="guide-step-title">Add your pet</div><div class="guide-step-desc">Click <strong>↓ Import from Immich</strong> if Immich already recognizes your pet as a person. Otherwise click <strong>+ Add pet</strong> to start from scratch.</div></div></div>
      <div class="guide-step"><div class="guide-step-num">2</div><div class="guide-step-body"><div class="guide-step-title">Find reference photos</div><div class="guide-step-desc">Select your pet and click <strong>Find references</strong>. Aim for 20–30 to start; results improve up to around 50.<ul style="margin:6px 0 0 16px;padding:0;"><li><strong>Add to pet</strong>: clear, close-up shot, your pet is the only subject.</li><li><strong>Skip as ref</strong>: not suitable as a reference shot, but still valid for tagging.</li><li><strong>Ignore</strong>: bad or irrelevant for this pet. Ignored photos won't appear again for this pet in references or tagging.</li><li><strong>Not a pet</strong>: photos that could confuse the classifier. Empty rooms, other species, ambiguous shots. Around 50 is enough.</li></ul>If you already know a specific photo you want to use, click <strong>Add manually</strong> and paste its Immich URL or asset ID.</div></div></div>
      <div class="guide-step"><div class="guide-step-num">3</div><div class="guide-step-body"><div class="guide-step-title">Add "not a pet" samples</div><div class="guide-step-desc">These teach the classifier what not to tag: empty rooms, other animals of a different species, ambiguous shots with no clear subject. Without them, the classifier will tag almost anything. In the <strong>Not a pet</strong> panel, click <strong>Find candidates</strong> to automatically surface more photos that might confuse the classifier. To add a specific photo directly, click <strong>Add manually</strong> and paste its Immich URL or asset ID.</div></div></div>
      <div class="guide-step"><div class="guide-step-num">4</div><div class="guide-step-body"><div class="guide-step-title">Run a test scan</div><div class="guide-step-desc">Set the <strong>Scan from</strong> date 1–2 weeks back and click <strong>Scan</strong>. Review low confidence results: add correct ones as refs, use <strong>Skip as ref</strong> for mixed-subject photos you still want tagged, and use <strong>Ignore</strong> for bad/irrelevant shots.</div></div></div>
      <div class="guide-step"><div class="guide-step-num">5</div><div class="guide-step-body"><div class="guide-step-title">Iterate</div><div class="guide-step-desc">Repeat steps 2–4 a couple of times. Results typically stabilize after 2–3 rounds.</div></div></div>
      <div class="guide-step"><div class="guide-step-num">6</div><div class="guide-step-body"><div class="guide-step-title">Run the full backfill</div><div class="guide-step-desc">Once happy with accuracy, set the scan date to when you got your pet and run the full scan. After that, new photos are tagged automatically every 5 minutes.</div></div></div>
    </div>
  </div>`;
  selectedCrops.clear(); lastClickedKey = null; updateSelUI();
}

function clearSearch() {
  scanDiscoverMode = false;
  setPhotoGridGrouped(false);
  document.getElementById('resultsLabel').textContent = '';
  document.getElementById('photoGrid').innerHTML = '<div class="empty" style="grid-column:1/-1; height:300px;"><div class="empty-icon">🐾</div><div class="empty-title">Find photos</div><div class="empty-sub">Click "Find references" to get started</div></div>';
  selectedCrops.clear(); lastClickedKey = null; updateSelUI();
}

async function selectPet(name) {
  if (activePet?.name === name) return;
  if (selectedCrops.size > 0) {
    const ok = confirm(`You have ${selectedCrops.size} selected photo${selectedCrops.size !== 1 ? 's' : ''} not yet assigned. Switch anyway?`);
    if (!ok) return;
  }
  negCandidateMode = false; borderlineMode = false; scanLowConfMode = false;
  scanDiscoverMode = false;
  activePet = pets.find(p => p.name === name);
  clearSearch(); renderSidebar();
  const scanPetSelect = document.getElementById('scanPetSelect');
  if (scanPetSelect && activePet?.name) {
    scanPetSelect.value = activePet.name;
  }
  document.getElementById('refsTitle').textContent = name;
  document.getElementById('findRefsBtn').style.display = '';
  document.getElementById('addByIdBtn').style.display = '';
  document.getElementById('clearRefsBtn').style.display = '';
  document.getElementById('viewSkippedBtn').style.display = '';
  document.getElementById('viewSkipAsRefBtn').style.display = '';
  await loadRefs(name);
  await loadNegatives();
}

async function loadRefs(name) {
  const grid = document.getElementById('refsGrid');
  grid.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const d = await api(`/api/pets/${encodeURIComponent(name)}/assets`);
    refsItems = d.assets;
    renderRefs(d.assets);
  } catch(e) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-sub">Error loading refs</div></div>'; }
}

function renderRefs(assets) {
  const grid = document.getElementById('refsGrid');
  if (!assets.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1;height:160px;"><div class="empty-sub">No references yet.<br>Click "Find references" to add some.</div></div>'; return; }
  grid.innerHTML = assets.map(a => {
    const cropArg = a.crop_idx != null ? a.crop_idx : 'null';
    return `<div class="ref-thumb">
      <a href="${immichUrl}/photos/${a.id}" target="_blank" rel="noopener" title="Open in Immich">
        <img src="${a.thumb}" loading="lazy" onerror="this.style.opacity=0.2">
      </a>
      <button class="ref-remove" onclick="removeRef('${a.id}', ${cropArg})" title="Remove">✕</button>
    </div>`;
  }).join('');
}

async function removeRef(assetId, cropIdx = null) {
  if (!activePet) return;
  const pet = activePet;
  try {
    const url = cropIdx != null
      ? `/api/pets/${encodeURIComponent(pet.name)}/assets/${assetId}?crop_idx=${cropIdx}`
      : `/api/pets/${encodeURIComponent(pet.name)}/assets/${assetId}`;
    await api(url, { method: 'DELETE' });
    refsItems = refsItems.filter(r => {
      if (r.id !== assetId) return true;
      if (cropIdx != null) return r.crop_idx !== cropIdx;
      return false;
    });
    const grid = document.getElementById('refsGrid');
    const scrollTop = grid.scrollTop;
    renderRefs(refsItems);
    grid.scrollTop = scrollTop;
    await refreshState();
    toast('Removed');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function assignSelected() {
  if (!activePet || !selectedCrops.size) return;
  const pet = activePet;
  const newCrops = [...selectedCrops.values()];
  const actionedAssetIds = [...new Set(newCrops.map(c => c.asset_id))];
  const existing = refsItems.map(r => ({ asset_id: r.id, crop_idx: r.crop_idx, bbox: r.bbox }));
  const seen = new Set();
  const merged = [...existing, ...newCrops].filter(c => {
    const k = c.crop_idx != null ? `${c.asset_id}_${c.crop_idx}` : c.asset_id;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  try {
    await api(`/api/pets/${encodeURIComponent(pet.name)}/assets`, { method: 'POST', body: { assets: merged } });
    selectedCrops.clear(); updateSelUI();
    dismissAssetsFromFocus(actionedAssetIds);
    await loadRefs(pet.name);
    await refreshState();
    toast(`Added to ${pet.name}`, 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Photo grid rendering helpers
// ---------------------------------------------------------------------------

function getCropData(el) {
  const cropIdx = el.dataset.cropIdx !== undefined && el.dataset.cropIdx !== '' ? parseInt(el.dataset.cropIdx) : null;
  const bbox = el.dataset.bbox ? JSON.parse(el.dataset.bbox) : null;
  return {
    asset_id: el.dataset.assetId,
    crop_idx: cropIdx,
    bbox,
    discover_group: el.dataset.discoverGroup || null,
    pet_name: el.dataset.petName || null,
  };
}

function collectTagBboxes(ids) {
  const idSet = new Set(ids || []);
  const bboxes = {};

  for (const crop of selectedCrops.values()) {
    if (!crop || !idSet.has(crop.asset_id)) continue;
    if (!Array.isArray(crop.bbox) || crop.bbox.length !== 4) continue;
    if (!(crop.asset_id in bboxes)) bboxes[crop.asset_id] = crop.bbox;
  }

  // Manual bbox edits take precedence over detected crop boxes.
  for (const id of idSet) {
    if (!manualBboxOverrides.has(id)) continue;
    const override = manualBboxOverrides.get(id);
    if (Array.isArray(override) && override.length === 4) {
      bboxes[id] = override;
    } else if (override === null) {
      delete bboxes[id];
    }
  }

  // For user-driven tagging, provide full image bbox as fallback for any asset without one
  for (const id of idSet) {
    if (!(id in bboxes)) {
      bboxes[id] = [0, 0, 1, 1];
    }
  }

  return bboxes;
}

function renderPhotoItems(a, thr) {
  const badge = a.score != null
    ? `<div class="score-badge ${a.score < thr ? 'score-low' : 'score-ok'}">${Math.round(a.score * 100)}%</div>`
    : '';
  const makeItem = (key, src, cropIdx, bbox) => {
    const cropIdxAttr = cropIdx != null ? `data-crop-idx="${cropIdx}"` : '';
    const bboxAttr = bbox ? `data-bbox='${JSON.stringify(bbox)}'` : '';
    const petNameAttr = a.pet_name ? `data-pet-name="${a.pet_name}"` : '';
    const inspectPayload = {
      bbox: bbox || null,
      pet_name: a.pet_name || null,
      prob: a.score != null ? a.score : null,
      date: a.date || null,
    };
    return `<div class="photo-thumb" id="th-${key}" data-asset-id="${a.id}" ${cropIdxAttr} ${bboxAttr}
      ${petNameAttr}
      onclick="toggleSelect(event,'${key}')" title="${a.filename || ''} · ${fmtDate(a.date)}">
      <img src="${src}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg/>'">
      ${renderOpenInspectButton(a.id, inspectPayload)}
      <div class="photo-check">✓</div>
      ${badge}
    </div>`;
  };
  if (a.crops && a.crops.length > 0) {
    return a.crops.map(c => makeItem(`${a.id}_${c.crop_idx}`, `/api/crop/${a.id}?bbox=${c.bbox.join(',')}`, c.crop_idx, c.bbox));
  }
  return [makeItem(a.id, a.thumb, null, null)];
}

function renderDiscoveryBadges(a) {
  const badges = [];
  if (a && a.already_tagged) {
    badges.push(
      `<span class="scan-meta-badge scan-meta-badge-tagged scan-meta-slot-1" title="Already tagged" aria-label="Already tagged">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M3 12l9-9h7l2 2v7l-9 9-9-9zm13-5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" fill="currentColor"></path>
        </svg>
      </span>`
    );
  }
  if (a && a.is_reference) {
    badges.push(
      `<span class="scan-meta-badge scan-meta-badge-ref ${a && a.already_tagged ? 'scan-meta-slot-2' : 'scan-meta-slot-1'}" title="Reference photo" aria-label="Reference photo">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z" fill="currentColor"></path>
        </svg>
      </span>`
    );
  }
  if (!badges.length) return '';
  return `<div class="scan-meta-badges scan-meta-badges-stack">${badges.join('')}</div>`;
}

function markGridItems(assets) {
  const refKeys = new Set(refsItems.map(r => r.crop_idx != null ? `${r.id}_${r.crop_idx}` : r.id));
  const negSet = new Set(negIds);
  assets.forEach(a => {
    const keys = (a.crops && a.crops.length > 0) ? a.crops.map(c => `${a.id}_${c.crop_idx}`) : [a.id];
    keys.forEach(key => {
      const el = document.getElementById('th-' + key);
      if (!el) return;
      if (refKeys.has(key) || refKeys.has(a.id)) el.classList.add('is-ref');
      if (negSet.has(a.id)) el.classList.add('is-neg');
    });
  });
}

function _dropAssetIdsFromScanCache(assetIdSet) {
  if (!lastScanResult || !assetIdSet || !assetIdSet.size) return;
  const keep = (list) => {
    if (!Array.isArray(list)) return list;
    return list.filter((a) => {
      const id = String((a && (a.asset_id || a.id)) || '');
      return id && !assetIdSet.has(id);
    });
  };
  lastScanResult.matched_assets = keep(lastScanResult.matched_assets);
  lastScanResult.low_conf_assets = keep(lastScanResult.low_conf_assets);
  if (Array.isArray(lastScanResult.matched_assets)) lastScanResult.matched_total = lastScanResult.matched_assets.length;
  if (Array.isArray(lastScanResult.low_conf_assets)) lastScanResult.low_conf_total = lastScanResult.low_conf_assets.length;
}

function _cleanupGroupedResultsLayout() {
  const grid = document.getElementById('photoGrid');
  if (!grid) return;

  [...grid.querySelectorAll('.scan-match-group')].forEach((group) => {
    const n = group.querySelectorAll('.photo-thumb').length;
    if (!n) {
      group.remove();
      return;
    }
    const badge = group.querySelector('.scan-match-group-head span');
    if (badge) badge.textContent = `${n}`;
  });

  [...grid.querySelectorAll('.scan-section')].forEach((section) => {
    const n = section.querySelectorAll('.photo-thumb').length;
    const badge = section.querySelector('.scan-section-count');
    if (badge) badge.textContent = `${n}`;
    const body = section.querySelector('.scan-section-body');
    if (body && !n && !body.querySelector('.scan-section-empty')) {
      body.innerHTML = '<div class="scan-section-empty">No items in this section</div>';
    }
  });

  const divider = grid.querySelector('.scan-section-divider');
  if (divider) {
    const focusCount = grid.querySelectorAll('.scan-section-focus .photo-thumb').length;
    const labeledCount = grid.querySelectorAll('.scan-section-labeled .photo-thumb').length;
    divider.style.display = (focusCount > 0 && labeledCount > 0) ? '' : 'none';
  }
}

function markAssetsAsTagged(assetIds) {
  // Update lastScanResult to mark assets as already_tagged so UI counts update correctly
  if (!lastScanResult) return;
  const idSet = new Set((assetIds || []).map(id => String(id)));
  
  // Update both matched_assets and low_conf_assets
  if (Array.isArray(lastScanResult.matched_assets)) {
    for (const asset of lastScanResult.matched_assets) {
      if (idSet.has(String(asset.asset_id))) {
        asset.already_tagged = true;
      }
    }
  }
  
  if (Array.isArray(lastScanResult.low_conf_assets)) {
    for (const asset of lastScanResult.low_conf_assets) {
      if (idSet.has(String(asset.asset_id))) {
        asset.already_tagged = true;
      }
    }
  }
}

function dismissAssetsFromFocus(assetIds) {
  const ids = [...new Set((assetIds || []).map((x) => String(x || '')).filter(Boolean))];
  if (!ids.length) return;
  const idSet = new Set(ids);

  for (const [key, crop] of Array.from(selectedCrops.entries())) {
    if (crop && idSet.has(String(crop.asset_id || ''))) selectedCrops.delete(key);
  }
  
  // Remove from scan results BEFORE calling updateSelUI so counts are accurate
  _dropAssetIdsFromScanCache(idSet);
  updateSelUI();

  const grid = document.getElementById('photoGrid');
  if (grid) {
    ids.forEach((id) => {
      grid.querySelectorAll(`[data-asset-id="${id}"]`).forEach((el) => el.remove());
    });
    _cleanupGroupedResultsLayout();

    const remaining = grid.querySelectorAll('.photo-thumb').length;
    if (!remaining) {
      setPhotoGridGrouped(false);
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1; height:200px;"><div class="empty-sub">No remaining assets in focus</div></div>';
      const label = document.getElementById('resultsLabel');
      if (label) label.textContent = '0 assets in focus';
    } else if (scanDiscoverMode) {
      const label = document.getElementById('resultsLabel');
      if (label) label.textContent = `${remaining} discover asset${remaining !== 1 ? 's' : ''} (grouped)`;
    }
  }

  if (document.getElementById('inspectModal')?.classList.contains('open')) {
    _setInspectNavigation();
  }
}

function advanceInspectAfterAction(assetId) {
  const currentId = String(assetId || inspectState.assetId || '');
  const modalOpen = document.getElementById('inspectModal')?.classList.contains('open');
  let target = null;

  if (modalOpen) {
    const buttons = inspectState.navButtons && inspectState.navButtons.length
      ? inspectState.navButtons
      : _getInspectNavButtons();
    const idx = (inspectState.navIndex >= 0 && inspectState.navIndex < buttons.length)
      ? inspectState.navIndex
      : buttons.findIndex((b) => (b.dataset.assetId || '') === currentId);

    if (idx >= 0 && buttons.length > 1) {
      const next = buttons[idx + 1] || buttons[idx - 1] || null;
      if (next) {
        target = {
          assetId: next.dataset.assetId || '',
          encoded: next.dataset.inspect || '',
        };
      }
    }
  }

  dismissAssetsFromFocus([currentId]);

  if (!modalOpen) return;
  if (target && target.assetId) {
    const buttons = _getInspectNavButtons();
    const nextIdx = buttons.findIndex((b) => (b.dataset.assetId || '') === target.assetId);
    openAssetInspect(null, target.assetId, target.encoded, nextIdx >= 0 ? nextIdx : null);
    return;
  }

  closeInspectModal();
}

// ---------------------------------------------------------------------------
// Ref suggestions
// ---------------------------------------------------------------------------

function viewFindRefs() {
  if (!activePet) return;
  if (activePet.ref_count > 0) viewBorderline();
  else viewSuggestions();
}

// ---------------------------------------------------------------------------
// Add by ID / link (refs and negatives)
// ---------------------------------------------------------------------------

let _addByIdMode = 'ref'; // 'ref' | 'neg'

function parseAssetId(input) {
  const s = (input || '').trim();
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const afterPhotos = s.match(new RegExp('photos/(' + UUID + ')', 'i'));
  if (afterPhotos) return afterPhotos[1];
  const any = s.match(new RegExp(UUID, 'i'));
  return any ? any[0] : null;
}

function _openAddByIdModal(mode) {
  _addByIdMode = mode;
  document.getElementById('addByIdInput').value = '';
  clearModalError('addByIdError');
  const example = 'e.g. a1b2c3d4-11aa-22bb-33cc-4d5e6f7a8b9c';
  if (mode === 'neg') {
    document.getElementById('addByIdTitle').textContent = 'Add "not a pet" by ID or link';
    document.getElementById('addByIdHint').textContent = `Paste an Immich photo URL or just the asset ID (${example}). It will be added directly to "not a pet".`;
  } else {
    document.getElementById('addByIdTitle').textContent = 'Add reference by ID or link';
    document.getElementById('addByIdHint').textContent = `Paste an Immich photo URL or just the asset ID (${example}). Detection will run, then you will review/adjust the bbox before saving.`;
  }
  document.getElementById('addByIdModal').classList.add('open');
  setTimeout(() => document.getElementById('addByIdInput').focus(), 100);
}

function openAddById() { if (activePet) _openAddByIdModal('ref'); }
function openAddNegById() { _openAddByIdModal('neg'); }

function closeAddById() {
  document.getElementById('addByIdModal').classList.remove('open');
  clearModalError('addByIdError');
}

async function submitAddById() {
  clearModalError('addByIdError');
  const id = parseAssetId(document.getElementById('addByIdInput').value);
  if (!id) { modalError('addByIdError', 'Could not find an asset ID. Paste an Immich photo link or the bare ID.'); return; }

  if (_addByIdMode === 'neg') {
    try {
      await api(`/api/asset/${id}/crops`); // validates asset exists
      await api('/api/negatives', { method: 'POST', body: { asset_ids: [id] } });
      closeAddById();
      await loadNegatives();
      toast('Added to "not a pet"', 'success');
    } catch(e) {
      let msg = e.message || 'Could not load asset';
      try { const j = JSON.parse(msg); if (j.detail) msg = j.detail; } catch(_) {}
      modalError('addByIdError', msg);
    }
    return;
  }

  // ref mode
  if (!activePet) return;
  const pet = activePet;
  try {
    const a = await api(`/api/asset/${id}/crops`);
    const crops = a.crops || [];
    const chosen = crops.length ? crops[0] : null;
    const payload = {
      bbox: chosen ? chosen.bbox : null,
      pet_name: pet.name,
      prob: null,
      date: a.date || null,
    };
    closeAddById();
    openAddByIdInspect(id, payload, pet.name, chosen ? chosen.crop_idx : null);
    toast(crops.length > 1 ? 'Reviewing first detected bbox; adjust if needed' : 'Review bbox, then click Save', 'success');
  } catch(e) {
    let msg = e.message || 'Could not load asset';
    try { const j = JSON.parse(msg); if (j.detail) msg = j.detail; } catch(_) {}
    modalError('addByIdError', msg);
  }
}

async function viewSuggestions() {
  if (!activePet) return;
  const pet = activePet;
  if (!pet.description) { toast('Edit this pet and add a description to use this feature', 'error'); return; }
  selectedCrops.clear(); lastClickedKey = null; updateSelUI();
  scanDiscoverMode = false;
  const grid = document.getElementById('photoGrid');
  setPhotoGridGrouped(false);
  const label = document.getElementById('resultsLabel');
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Finding similar photos… this may take a moment</div>';
  label.textContent = 'Finding references…';
  try {
    const d = await api(`/api/pets/${encodeURIComponent(pet.name)}/suggestions`);
    label.textContent = `${d.assets.length} photo${d.assets.length !== 1 ? 's' : ''} similar to ${pet.name}'s refs`;
    if (!d.assets.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-icon">🐾</div><div class="empty-title">No suggestions found</div><div class="empty-sub">Add more refs or broaden the date range</div></div>';
      return;
    }
    grid.innerHTML = d.assets.flatMap(a => renderPhotoItems(a, 0.8)).join('');
    markGridItems(d.assets);
  } catch(e) {
    label.textContent = 'Failed to load suggestions';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-sub">${e.message}</div></div>`;
    toast('Suggestions error: ' + e.message, 'error');
  }
}

async function viewBorderline() {
  if (!activePet || !activePet.ref_count) return;
  const myGen = ++blGeneration;
  if (blPollTimer) { clearInterval(blPollTimer); blPollTimer = null; }
  negCandidateMode = false; borderlineMode = true;
  scanDiscoverMode = false;
  selectedCrops.clear(); lastClickedKey = null; updateSelUI();
  const grid = document.getElementById('photoGrid');
  setPhotoGridGrouped(false);
  const label = document.getElementById('resultsLabel');
  const petName = activePet.name;
  grid.innerHTML = '<div class="loading" id="blLoadMsg" style="grid-column:1/-1">Loading…</div>';
  label.textContent = 'Finding references…';

  blPollTimer = setInterval(async () => {
    if (blGeneration !== myGen) { clearInterval(blPollTimer); blPollTimer = null; return; }
    try {
      const p = await api(`/api/pets/${encodeURIComponent(petName)}/borderline/progress`);
      const el = document.getElementById('blLoadMsg');
      if (!el) return;
      if (p.total > 0) el.textContent = `Loading ${Math.round(p.current / p.total * 100)}%…`;
      else if (p.running) el.textContent = 'Loading…';
    } catch(_) {}
  }, 1000);

  try {
    const d = await api(`/api/pets/${encodeURIComponent(petName)}/borderline`);
    clearInterval(blPollTimer); blPollTimer = null;
    if (blGeneration !== myGen) return;
    label.textContent = `${d.assets.length} photo${d.assets.length !== 1 ? 's' : ''} ${petName} might be missing. Add good ones as refs to improve accuracy.`;
    if (!d.assets.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-icon">🐾</div><div class="empty-title">No missed photos found</div><div class="empty-sub">The classifier is either very confident or not finding this pet at all</div></div>';
      return;
    }
    const thr = d.threshold ?? 0.8;
    grid.innerHTML = d.assets.flatMap(a => renderPhotoItems(a, thr)).join('');
    markGridItems(d.assets);
  } catch(e) {
    clearInterval(blPollTimer); blPollTimer = null;
    if (blGeneration !== myGen) return;
    label.textContent = 'Failed to load missed photos';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-sub">${e.message}</div></div>`;
    toast('Error: ' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------

function toggleSelect(e, key) {
  const el = document.getElementById('th-' + key); if (!el) return;
  if (el.classList.contains('is-ref')) return;
  if (el.classList.contains('is-neg')) return;
  if (e.shiftKey && lastClickedKey && lastClickedKey !== key) {
    const thumbs = [...document.querySelectorAll('#photoGrid .photo-thumb')];
    const fromEl = document.getElementById('th-' + lastClickedKey);
    const fromIdx = thumbs.indexOf(fromEl), toIdx = thumbs.indexOf(el);
    if (fromIdx !== -1 && toIdx !== -1) {
      const lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx);
      for (let i = lo; i <= hi; i++) {
        if (thumbs[i].classList.contains('is-ref') || thumbs[i].classList.contains('is-neg')) continue;
        const tkey = thumbs[i].id.slice(3);
        if (!selectedCrops.has(tkey)) { selectedCrops.set(tkey, getCropData(thumbs[i])); thumbs[i].classList.add('selected'); }
      }
    }
  } else {
    if (selectedCrops.has(key)) { selectedCrops.delete(key); el.classList.remove('selected'); }
    else { selectedCrops.set(key, getCropData(el)); el.classList.add('selected'); }
    lastClickedKey = key;
  }
  updateSelUI();
}

function updateSelUI() {
  const n = selectedCrops.size;
  const discoverSelected = [...selectedCrops.values()];
  const hasAnyDiscover = discoverSelected.some(c => c.discover_group === 'matched' || c.discover_group === 'low');

  document.getElementById('selCount').textContent = n ? `${n} selected` : '';
  document.getElementById('assignBtn').style.display = (n && activePet && !negCandidateMode && !scanLowConfMode && !scanDiscoverMode) ? '' : 'none';
  document.getElementById('skipRefBtn').style.display = n ? '' : 'none';
  document.getElementById('skipBtn').style.display = n ? '' : 'none';
  document.getElementById('addNegBtn').style.display = n ? '' : 'none';
  document.getElementById('scanPetBtns').style.display = (n && scanLowConfMode) ? 'flex' : 'none';

  const tagAllBtn = document.getElementById('discoverTagAllBtn');
  const petGroup = document.getElementById('discoverPetGroup');
  const tagPetBtn = document.getElementById('discoverTagPetBtn');
  const refPetBtn = document.getElementById('discoverRefPetBtn');
  if (tagAllBtn) {
    // Count only untagged matched assets
    const matched = (lastScanResult?.matched_assets || []);
    const untaggedCount = matched.filter(a => !a.already_tagged && !a.is_reference).length;
    tagAllBtn.textContent = `Tag all confident (${untaggedCount})`;
    tagAllBtn.style.display = (scanDiscoverMode && n === 0 && untaggedCount > 0) ? '' : 'none';
  }
  if (petGroup) petGroup.style.display = (scanDiscoverMode && n && hasAnyDiscover) ? 'flex' : 'none';
  if (tagPetBtn) {
    tagPetBtn.textContent = `Tag pet (${n})`;
    tagPetBtn.disabled = !scanDiscoverMode || !hasAnyDiscover;
  }
  if (refPetBtn) {
    refPetBtn.textContent = `Tag pet + ref (${n})`;
    refPetBtn.disabled = !scanDiscoverMode || !hasAnyDiscover;
  }
}

async function skipSelected() {
  if (!selectedCrops.size) return;
  const byPet = new Map();
  for (const c of selectedCrops.values()) {
    const petName = c.pet_name || activePet?.name || '';
    if (!byPet.has(petName)) byPet.set(petName, new Set());
    byPet.get(petName).add(c.asset_id);
  }

  const ids = [...new Set([...selectedCrops.values()].map(c => c.asset_id))];
  try {
    for (const [petName, setIds] of byPet) {
      const assetIds = [...setIds];
      await api('/api/skipped', {
        method: 'POST',
        body: petName ? { asset_ids: assetIds, pet_name: petName } : { asset_ids: assetIds },
      });
    }
    dismissAssetsFromFocus(ids);
    toast(`Ignored ${ids.length} photo${ids.length !== 1 ? 's' : ''} for this pet.`, 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function skipAsRefSelected() {
  if (!selectedCrops.size) return;
  const byPet = new Map();
  const processedIds = new Set();
  for (const c of selectedCrops.values()) {
    const petName = c.pet_name || activePet?.name || '';
    if (!petName) continue;
    if (!byPet.has(petName)) byPet.set(petName, new Set());
    byPet.get(petName).add(c.asset_id);
    processedIds.add(c.asset_id);
  }

  const ids = [...processedIds];
  const missingPet = [...selectedCrops.values()].some(c => !(c.pet_name || activePet?.name));
  if (!byPet.size) {
    toast('Choose a pet first.', 'error');
    return;
  }

  try {
    for (const [petName, setIds] of byPet) {
      const assetIds = [...setIds];
      await api('/api/skip-as-ref', {
        method: 'POST',
        body: { asset_ids: assetIds, pet_name: petName },
      });
    }
    dismissAssetsFromFocus(ids);
    if (missingPet) {
      toast(`Skipped ${ids.length} photo${ids.length !== 1 ? 's' : ''} as references where a pet could be inferred.`, 'success');
    } else {
      toast(`Skipped ${ids.length} photo${ids.length !== 1 ? 's' : ''} as references.`, 'success');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------------

function updateNegStatus() {
  const el = document.getElementById('negCount');
  el.textContent = negIds.length;
  el.style.color = '';
}

async function loadNegatives() {
  try {
    const d = await api('/api/negatives');
    negIds = d.assets.map(a => a.id);
    updateNegStatus();
    document.getElementById('clearNegsBtn').style.display = negIds.length ? '' : 'none';
    const grid = document.getElementById('negGrid');
    if (!negIds.length) { grid.innerHTML = ''; return; }
    grid.innerHTML = d.assets.map(a => `
      <div class="ref-thumb">
        <a href="${immichUrl}/photos/${a.id}" target="_blank" rel="noopener" title="Open in Immich">
          <img src="${a.thumb}" loading="lazy" onerror="this.style.opacity=0.2">
        </a>
        <button class="ref-remove" onclick="removeNegative('${a.id}')" title="Remove">✕</button>
      </div>`).join('');
  } catch(e) { console.warn('loadNegatives:', e); }
}

async function addSelectedAsNegatives() {
  if (!selectedCrops.size) return;
  const assetIds = [...new Set([...selectedCrops.values()].map(c => c.asset_id))];
  try {
    await api('/api/negatives', { method: 'POST', body: { asset_ids: assetIds } });
    negIds = [...new Set([...negIds, ...assetIds])];
    dismissAssetsFromFocus(assetIds);
    await loadNegatives();
    toast('Added to "not my pets"', 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function viewNegCandidates() {
  const myGen = ++negGeneration;
  if (negPollTimer) { clearInterval(negPollTimer); negPollTimer = null; }
  negCandidateMode = true;
  scanDiscoverMode = false;
  selectedCrops.clear(); lastClickedKey = null; updateSelUI();
  const grid = document.getElementById('photoGrid');
  setPhotoGridGrouped(false);
  const label = document.getElementById('resultsLabel');
  grid.innerHTML = '<div class="loading" id="negLoadMsg" style="grid-column:1/-1">Loading…</div>';
  label.textContent = 'Finding candidates…';

  negPollTimer = setInterval(async () => {
    if (negGeneration !== myGen) { clearInterval(negPollTimer); negPollTimer = null; return; }
    try {
      const p = await api('/api/suggestions/negatives/progress');
      const el = document.getElementById('negLoadMsg');
      if (!el) return;
      if (p.total > 0) el.textContent = `Loading ${Math.round(p.current / p.total * 100)}%…`;
      else if (p.running) el.textContent = 'Loading…';
    } catch(_) {}
  }, 1000);

  try {
    const d = await api('/api/suggestions/negatives');
    clearInterval(negPollTimer); negPollTimer = null;
    if (negGeneration !== myGen) return;
    updateNegStatus();
    label.textContent = `${d.assets.length} candidate${d.assets.length !== 1 ? 's' : ''} for "not my pets"`;
    if (!d.assets.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-icon">🐾</div><div class="empty-title">No candidates found</div><div class="empty-sub">Classifier is well calibrated</div></div>';
      return;
    }
    const thr = d.threshold || 0.8;
    grid.innerHTML = d.assets.flatMap(a => renderPhotoItems(a, thr)).join('');
    const negSet = new Set(negIds);
    d.assets.forEach(a => {
      if (negSet.has(a.id)) document.getElementById('th-' + a.id)?.classList.add('is-neg');
    });
  } catch(e) {
    clearInterval(negPollTimer); negPollTimer = null;
    if (negGeneration !== myGen) return;
    label.textContent = 'Failed to load candidates';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-sub">${e.message}</div></div>`;
    toast('Error: ' + e.message, 'error');
  }
}

async function clearAllRefs() {
  if (!activePet) return;
  const pet = activePet;
  if (!confirm(`Remove all reference photos for ${pet.name} from Pet Tagger? This will not affect Immich.`)) return;
  try {
    await api(`/api/pets/${encodeURIComponent(pet.name)}/refs`, { method: 'DELETE' });
    refsItems = [];
    await loadRefs(pet.name);
    await refreshState();
    toast('All refs cleared', 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function clearAllNegatives() {
  if (!confirm(`Remove all "not my pets" photos from Pet Tagger? This will not affect Immich.`)) return;
  try {
    await api('/api/negatives/all', { method: 'DELETE' });
    negIds = [];
    await loadNegatives();
    toast('All "not my pets" cleared', 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function removeNegative(id) {
  try {
    await api(`/api/negatives/${id}`, { method: 'DELETE' });
    negIds = negIds.filter(i => i !== id);
    await loadNegatives();
    document.getElementById('th-' + id)?.classList.remove('is-neg');
    toast('Removed from "not my pets"');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Poll status
// ---------------------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return new Date(+y, m - 1, +d).toLocaleDateString();
}


function relativeTime(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}


// ---------------------------------------------------------------------------
// Scan timestamp
// ---------------------------------------------------------------------------

async function loadTimestamp() {
  try {
    const d = await api('/api/timestamp');
    if (d.timestamp) document.getElementById('scanDate').value = d.timestamp.slice(0, 10);
  } catch(e) {}
}

async function loadScanResult() {
  try {
    lastScanResult = await api('/api/scan/result');
    showScanResult(lastScanResult);
  } catch(_) {}
}

function showScanResult(r) {
  const el = document.getElementById('scanResult');
  const stopBtn = document.getElementById('stopScanBtn');
  if (!r || r.status === 'none') { el.style.display = 'none'; stopBtn.style.display = 'none'; return; }
  el.className = 'scan-result';
  el.style.display = '';
  const stat = (label, val, cls) => `<div class="poll-stat"><span class="poll-stat-label">${label}</span><span class="poll-stat-val ${val > 0 ? cls : ''}">${val}</span></div>`;
  const targetLabel = r.pet_name ? ` for ${r.pet_name}` : '';
  if (r.status === 'running') {
    stopBtn.style.display = '';
    if (r.discover_only) {
      el.innerHTML = `<div class="scan-result-header">Finding pet matches${targetLabel}…</div>`;
      return;
    }
    const dateStr = r.current_date ? new Date(r.current_date + 'T00:00:00').toLocaleDateString() : '';
    const c = r.counts || {};
    el.innerHTML = `<div class="scan-result-header">Scanning${targetLabel}…</div>` +
      (dateStr ? `<div style="font-size:11px;color:var(--text3);margin-top:4px;">${dateStr}</div>` : '') +
      '<div class="poll-stats" style="margin-top:6px;">' +
      stat('Tagged', c.added || 0, 'nonzero-good') +
      stat('Low conf.', c.low_confidence || 0, 'nonzero-warn') +
      stat('Other', c.unknown || 0, '') +
      stat('Already tagged', c.already_tagged || 0, '') +
      (c.failed > 0 ? stat('Failed', c.failed, 'nonzero-bad') : '') +
      '</div>';
    return;
  }
  stopBtn.style.display = 'none';
  if (r.status === 'stopped') {
    el.innerHTML = '<div class="scan-result-header">Scan stopped</div>';
    return;
  }
  if (r.status === 'error') {
    el.innerHTML = `<div class="scan-result-header">Scan failed</div><div style="font-size:11px;color:var(--danger);margin-top:4px;">${r.error || ''}</div>`;
    return;
  }
  if (r.discover_only) {
    const matched = r.matched_total || 0;
    const lowConf = r.low_conf_total || 0;
    const inScope = r.in_scope_total || 0;
    el.innerHTML = `<div class="scan-result-header">Discover result${targetLabel}</div>` +
      `<div style="font-size:11px;color:var(--text2);margin-top:4px;">Matches: ${matched} · Low confidence: ${lowConf} / In scope: ${inScope}</div>` +
      '<button class="btn" style="font-size:11px;margin-top:8px;width:100%;" onclick="viewInScopeAssets()">Show discover groups</button>';
    viewInScopeAssets();
    return;
  }
  if (r.counts) {
    const c = r.counts;
    el.innerHTML = '<div class="scan-result-header">Scan result</div>' +
      '<div class="poll-stats" style="margin-top:6px;">' +
      stat('Tagged', c.added, 'nonzero-good') +
      stat('Low conf.', c.low_confidence, 'nonzero-warn') +
      stat('Other', c.unknown, '') +
      stat('Out of range', c.out_of_range, '') +
      stat('Already tagged', c.already_tagged, '') +
      (c.failed > 0 ? stat('Failed', c.failed, 'nonzero-bad') : '') +
      (c.no_thumb > 0 ? stat('No thumb', c.no_thumb, 'nonzero-warn') : '') +
      '</div>' +
      (c.low_confidence > 0 ? `<button class="btn" style="font-size:11px;margin-top:8px;width:100%;" onclick="viewScanLowConf()">Review ${c.low_confidence} low confidence</button>` : '');
  }
}

function toggleDiscoverSection(sectionClass, btnEl) {
  const grid = document.getElementById('photoGrid');
  if (!grid) return;
  const section = grid.querySelector(`.${sectionClass}`);
  if (!section) return;
  section.classList.toggle('scan-section-collapsed');
  const collapsed = section.classList.contains('scan-section-collapsed');
  if (btnEl) {
    btnEl.textContent = collapsed ? 'Show' : 'Hide';
    btnEl.setAttribute('aria-expanded', String(!collapsed));
  }
}

function viewInScopeAssets() {
  scanDiscoverMode = true;
  scanLowConfMode = false;
  negCandidateMode = false;
  borderlineMode = false;
  selectedCrops.clear();
  lastClickedKey = null;
  updateSelUI();

  const grid = document.getElementById('photoGrid');
  setPhotoGridGrouped(true);
  const label = document.getElementById('resultsLabel');
  const assets = (lastScanResult && lastScanResult.matched_assets) ? lastScanResult.matched_assets : [];
  const lowConfAssets = (lastScanResult && lastScanResult.low_conf_assets) ? lastScanResult.low_conf_assets : [];

  const totalShown = assets.length + lowConfAssets.length;
  label.textContent = `${totalShown} discover asset${totalShown !== 1 ? 's' : ''} (grouped)`;
  if (!totalShown) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1; height:200px;"><div class="empty-sub">No pet matches found for this date range</div></div>';
    return;
  }

  const candidates = [
    ...assets.map((a) => ({ ...a, _discoverGroup: 'matched', _petName: (a.pet_name || 'Unknown').trim() || 'Unknown' })),
    ...lowConfAssets.map((a) => ({ ...a, _discoverGroup: 'low', _petName: (a.pet_name || 'candidate').trim() || 'candidate' })),
  ];
  const focusItems = candidates.filter((a) => !(a.already_tagged || a.is_reference));
  const labeledItems = candidates.filter((a) => (a.already_tagged || a.is_reference));
  let discoverCardSeq = 0;

  const renderSection = (title, cls, items, collapsedDefault = false) => {
    const renderPetGroups = (byPet, lowOnly = false) => {
      const petNames = Object.keys(byPet).sort((a, b) => a.localeCompare(b));
      return petNames.map((pet) => {
        const petItems = byPet[pet].slice().sort((a, b) => {
          const pa = Number(a.prob || 0);
          const pb = Number(b.prob || 0);
          if (pb !== pa) return pb - pa;
          const da = String(a.date || '');
          const db = String(b.date || '');
          if (da !== db) return da.localeCompare(db);
          return String(a.asset_id || '').localeCompare(String(b.asset_id || ''));
        });
        const thumbs = petItems.map((a) => {
          const isLow = a._discoverGroup === 'low';
          const score = Math.round((a.prob || 0) * 100);
          const titleSuffix = isLow ? ' (low confidence)' : '';
          const key = `disc_${discoverCardSeq++}`;
          return `
            <div class="photo-thumb" id="th-${key}" data-asset-id="${a.asset_id}" data-discover-group="${a._discoverGroup}" data-pet-name="${pet}" ${a.bbox ? `data-bbox='${JSON.stringify(a.bbox)}'` : ''}
              onclick="toggleSelect(event,'${key}')" title="${fmtDate(a.date)} · ${score}% ${pet}${titleSuffix}">
              <img src="/api/crop/${a.asset_id}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg/>'">
              ${renderOpenInspectButton(a.asset_id, { bbox: a.bbox || null, pet_name: pet, prob: a.prob || null, date: a.date || null })}
              ${renderDiscoveryBadges(a)}
              <div class="photo-check">✓</div>
              <div class="score-badge ${isLow ? 'score-low' : 'score-ok'}">${score}%</div>
              <div class="scan-match-label">${pet}</div>
            </div>`;
        }).join('');
        const headLabel = lowOnly ? `Low confidence - ${pet}` : pet;
        return `
          <section class="scan-match-group${lowOnly ? ' scan-match-group-low' : ''}">
            <div class="scan-match-group-head">${headLabel} <span>${petItems.length}</span></div>
            <div class="scan-match-grid">${thumbs}</div>
          </section>`;
      }).join('');
    };

    const confidentByPet = {};
    const lowByPet = {};
    for (const item of items) {
      const pet = item._petName;
      if (item._discoverGroup === 'low') {
        if (!lowByPet[pet]) lowByPet[pet] = [];
        lowByPet[pet].push(item);
      } else {
        if (!confidentByPet[pet]) confidentByPet[pet] = [];
        confidentByPet[pet].push(item);
      }
    }

    const confidentGroups = renderPetGroups(confidentByPet, false);
    const lowGroups = renderPetGroups(lowByPet, true);
    const groups = [confidentGroups, lowGroups].filter(Boolean).join('');

    const body = groups || '<div class="scan-section-empty">No items in this section</div>';
    return `
      <section class="scan-section ${cls}${collapsedDefault ? ' scan-section-collapsed' : ''}">
        <div class="scan-section-head">${title} <span class="scan-section-count">${items.length}</span><button class="scan-section-toggle" type="button" onclick="toggleDiscoverSection('${cls}', this)" aria-expanded="${collapsedDefault ? 'false' : 'true'}">${collapsedDefault ? 'Show' : 'Hide'}</button></div>
        <div class="scan-section-body">${body}</div>
      </section>`;
  };

  grid.innerHTML = [
    renderSection('Needs review', 'scan-section-focus', focusItems, false),
    '<div class="scan-section-divider"></div>',
    renderSection('Already tagged / reference', 'scan-section-labeled', labeledItems, true),
  ].join('');

  const divider = grid.querySelector('.scan-section-divider');
  if (divider && (!focusItems.length || !labeledItems.length)) divider.style.display = 'none';
  const negSet = new Set(negIds);
  [...grid.querySelectorAll('.photo-thumb')].forEach(el => {
    const aid = el.dataset.assetId;
    if (aid && negSet.has(aid)) el.classList.add('is-neg');
  });
  const petSelect = document.getElementById('discoverPetSelect');
  const opts = pets.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  if (petSelect) {
    const current = petSelect.value;
    petSelect.innerHTML = opts;
    if (current && pets.some(p => p.name === current)) petSelect.value = current;
  }
  updateSelUI();
}

async function viewScanLowConf() {
  scanDiscoverMode = false;
  scanLowConfMode = true;
  negCandidateMode = false; borderlineMode = false;
  selectedCrops.clear(); lastClickedKey = null;
  const grid = document.getElementById('photoGrid');
  setPhotoGridGrouped(false);
  const label = document.getElementById('resultsLabel');
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading low confidence results…</div>';
  label.textContent = 'Loading…';
  const scanPetBtns = document.getElementById('scanPetBtns');
  scanPetBtns.innerHTML = pets.map(p => `<button class="btn btn-primary" title="Clear, close-up shot, your pet is the only subject.">${p.name}</button>`).join('');
  [...scanPetBtns.children].forEach((btn, i) => { btn.onclick = () => scanAssignSelected(pets[i].name); });
  updateSelUI();
  try {
    const d = await api('/api/scan/low-confidence');
    if (!d.assets.length) {
      label.textContent = 'No low confidence results';
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1; height:200px;"><div class="empty-sub">All results were confident or unknown</div></div>';
      return;
    }
    label.textContent = `${d.assets.length} low confidence result${d.assets.length !== 1 ? 's' : ''}`;
    const thr = d.threshold ?? 0.8;
    const negSet = new Set(negIds);
    grid.innerHTML = d.assets.map(a => {
      const cls = a.score < thr ? 'score-low' : 'score-ok';
      const bboxAttr = a.bbox ? `data-bbox='${JSON.stringify(a.bbox)}'` : '';
      return `<div class="photo-thumb" id="th-${a.id}" data-asset-id="${a.id}"
        ${bboxAttr}
        onclick="toggleSelect(event,'${a.id}')" title="${fmtDate(a.date)} · ${Math.round(a.score * 100)}% ${a.pet_name}">
        <img src="${a.thumb}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg/>'">
        ${renderOpenInspectButton(a.id, { bbox: a.bbox || null, pet_name: a.pet_name || null, prob: a.score || null, date: a.date || null })}
        <div class="photo-check">✓</div>
        <div class="score-badge ${cls}">${Math.round(a.score * 100)}%</div>
      </div>`;
    }).join('');
    d.assets.forEach(a => { if (negSet.has(a.id)) document.getElementById('th-' + a.id)?.classList.add('is-neg'); });
  } catch(e) {
    label.textContent = 'Failed to load';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1; height:200px;"><div class="empty-sub">${e.message}</div></div>`;
  }
}

async function scanAssignSelected(petName) {
  if (!selectedCrops.size) return;
  const newCrops = [...selectedCrops.values()];
  const actionedAssetIds = [...new Set(newCrops.map(c => c.asset_id))];
  try {
    const existing = await api(`/api/pets/${encodeURIComponent(petName)}/assets`);
    const existingCrops = existing.assets.map(a => ({ asset_id: a.id, crop_idx: a.crop_idx, bbox: a.bbox }));
    const seen = new Set();
    const merged = [...existingCrops, ...newCrops].filter(c => {
      const k = c.crop_idx != null ? `${c.asset_id}_${c.crop_idx}` : c.asset_id;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    await api(`/api/pets/${encodeURIComponent(petName)}/assets`, { method: 'POST', body: { assets: merged } });
    dismissAssetsFromFocus(actionedAssetIds);
    await refreshState();
    toast(`Added ${newCrops.length} to ${petName}`, 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function addRefsForAssetIds(petName, ids) {
  if (!ids.length) return;
  const selected = [...selectedCrops.values()].filter(c => ids.includes(c.asset_id));
  if (!selected.length) return;
  const newCrops = selected.map(c => ({ asset_id: c.asset_id, crop_idx: c.crop_idx ?? null, bbox: c.bbox ?? null }));
  const existing = await api(`/api/pets/${encodeURIComponent(petName)}/assets`);
  const existingCrops = existing.assets.map(a => ({ asset_id: a.id, crop_idx: a.crop_idx, bbox: a.bbox }));
  const seen = new Set();
  const merged = [...existingCrops, ...newCrops].filter(c => {
    const k = c.crop_idx != null ? `${c.asset_id}_${c.crop_idx}` : c.asset_id;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  await api(`/api/pets/${encodeURIComponent(petName)}/assets`, { method: 'POST', body: { assets: merged } });
}

async function tagSelectedAsChosenPet() {
  const petName = document.getElementById('discoverPetSelect')?.value;
  if (!petName) {
    toast('Choose a pet first', 'error');
    return;
  }
  await tagSelectedAsPet(petName);
}

async function tagAndRefSelectedChosenPet() {
  const petName = document.getElementById('discoverPetSelect')?.value;
  if (!petName) {
    toast('Choose a pet first', 'error');
    return;
  }
  await tagAndRefSelected(petName);
}

async function tagAndRefSelected(petName) {
  if (!selectedCrops.size) return;
  const ids = [...new Set([...selectedCrops.values()].map(c => c.asset_id))];
  const bboxes = collectTagBboxes(ids);
  if (!ids.length) return;
  try {
    const tagBody = { asset_ids: ids, pet_name: petName, use_match: false };
    if (Object.keys(bboxes).length) tagBody.bboxes = bboxes;
    const tagResult = await api('/api/scan/tag', { method: 'POST', body: tagBody });
    if (!tagResult.failed && ((tagResult.tagged || 0) + (tagResult.already_tagged || 0) > 0)) {
      markAssetsAsTagged(ids);
    }
    await addRefsForAssetIds(petName, ids);
    dismissAssetsFromFocus(ids);
    await refreshState();
    toast(`Tagged ${tagResult.tagged}, referenced ${ids.length}, already tagged ${tagResult.already_tagged}, no bbox ${tagResult.skipped_no_bbox || 0}, failed ${tagResult.failed}`, tagResult.failed ? 'error' : 'success');
  } catch (e) {
    toast('Tag + ref failed: ' + e.message, 'error');
  }
}

async function tagSelectedAsPet(petName) {
  if (!selectedCrops.size) return;
  const ids = [...new Set([...selectedCrops.values()].map(c => c.asset_id))];
  const bboxes = collectTagBboxes(ids);
  try {
    const tagBody = { asset_ids: ids, pet_name: petName, use_match: false };
    if (Object.keys(bboxes).length) tagBody.bboxes = bboxes;
    const r = await api('/api/scan/tag', { method: 'POST', body: tagBody });
    if (!r.failed) {
      markAssetsAsTagged(ids);
      dismissAssetsFromFocus(ids);
    }
    toast(`Tagged as ${petName}: ${r.tagged}, already tagged ${r.already_tagged}, no bbox ${r.skipped_no_bbox || 0}, failed ${r.failed}`, r.failed ? 'error' : 'success');
  } catch (e) {
    toast('Tagging failed: ' + e.message, 'error');
  }
}

async function tagAllConfidentMatches() {
  const matched = (lastScanResult?.matched_assets || []);
  const bboxes = {};
  
  // Collect manual overrides and provide full image bbox fallback for assets without bbox
  for (const m of matched) {
    const aid = m.asset_id;
    const manualOverride = manualBboxOverrides.get(aid);
    
    if (manualBboxOverrides.has(aid)) {
      // Manual override exists - use it if it's valid, otherwise use fallback
      if (Array.isArray(manualOverride) && manualOverride.length === 4) {
        bboxes[aid] = manualOverride;
      } else {
        // Manual override was cleared (null) - use full image bbox
        bboxes[aid] = [0, 0, 1, 1];
      }
    } else if (m.bbox && Array.isArray(m.bbox) && m.bbox.length === 4) {
      bboxes[aid] = m.bbox;
    } else {
      // Default to full image bbox for user-driven tagging
      bboxes[aid] = [0, 0, 1, 1];
    }
  }
  
  console.log('tagAllConfidentMatches:', { matchedCount: matched.length, bboxesCount: Object.keys(bboxes).length });
  
  try {
    const tagBody = { use_match: true };
    if (Object.keys(bboxes).length) tagBody.bboxes = bboxes;
    const r = await api('/api/scan/tag', { method: 'POST', body: tagBody });
    console.log('Tag response:', r);
    if (!r.failed && scanDiscoverMode) {
      const ids = [...document.querySelectorAll('#photoGrid .scan-section-focus .photo-thumb[data-discover-group="matched"]')]
        .map(el => el.dataset.assetId)
        .filter(Boolean);
      if ((r.tagged || 0) + (r.already_tagged || 0) > 0) {
        markAssetsAsTagged(matched.map(m => m.asset_id));
      }
      dismissAssetsFromFocus(ids);
    }
    toast(`Tagged ${r.tagged}, already tagged ${r.already_tagged}, no bbox ${r.skipped_no_bbox || 0}, failed ${r.failed}`, r.failed ? 'error' : 'success');
  } catch (e) {
    console.error('Tag error:', e);
    toast('Tagging failed: ' + e.message, 'error');
  }
}

async function applyTimestamp() {
  const val = document.getElementById('scanDate').value;
  if (!val) { toast('Pick a date first', 'error'); return; }
  const untilVal = document.getElementById('scanUntil').value || null;
  const petName = document.getElementById('scanPetSelect')?.value || null;
  const discoverOnly = true;
  try {
    await api('/api/timestamp', { method: 'POST', body: { date: val } });
    await api('/api/scan', { method: 'POST', body: { scan_until: untilVal, discover_only: discoverOnly, pet_name: petName } });

    // Keep sidebar selection aligned with scan target to avoid cross-pet context drift.
    if (petName) {
      activePet = pets.find(p => p.name === petName) || null;
      renderSidebar();
      document.getElementById('refsTitle').textContent = petName;
      document.getElementById('findRefsBtn').style.display = '';
      document.getElementById('addByIdBtn').style.display = '';
      document.getElementById('clearRefsBtn').style.display = '';
      await loadRefs(petName);
    } else {
      activePet = null;
      renderSidebar();
      document.getElementById('refsTitle').textContent = 'No pet selected';
      document.getElementById('findRefsBtn').style.display = 'none';
      document.getElementById('addByIdBtn').style.display = 'none';
      document.getElementById('clearRefsBtn').style.display = 'none';
      document.getElementById('refsGrid').innerHTML = '<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-sub">Select a pet</div></div>';
    }

    lastScanResult = { status: 'running', discover_only: discoverOnly, pet_name: petName };
    showScanResult(lastScanResult);
    const iv = setInterval(async () => {
      try {
        const r = await api('/api/scan/result');
        lastScanResult = r;
        showScanResult(r);
        if (r.status !== 'running') { clearInterval(iv); }
      } catch(_) {}
    }, 2000);
  } catch(e) {
    toast(e.message, 'error');
  }
}

async function stopScan() {
  try {
    await api('/api/scan/stop', { method: 'POST' });
    showScanResult({ status: 'stopped' });
  } catch(e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function modalError(id, msg) { document.getElementById(id).textContent = msg; }
function clearModalError(id) { document.getElementById(id).textContent = ''; }

function openAddPet() {
  document.getElementById('petName').value = ''; document.getElementById('petDescription').value = ''; document.getElementById('petSince').value = ''; document.getElementById('petUntil').value = '';
  document.getElementById('addPetModal').classList.add('open');
  setTimeout(() => document.getElementById('petName').focus(), 100);
}
function closeModal() { document.getElementById('addPetModal').classList.remove('open'); clearModalError('addPetError'); }

async function submitAddPet() {
  clearModalError('addPetError');
  const name = document.getElementById('petName').value.trim();
  if (!name) { modalError('addPetError', 'Name cannot be empty'); return; }
  const description = document.getElementById('petDescription').value.trim();
  if (!description) { modalError('addPetError', 'Description is required'); return; }
  const sinceRaw = document.getElementById('petSince').value;
  const untilRaw = document.getElementById('petUntil').value;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (sinceRaw && !dateRe.test(sinceRaw)) { modalError('addPetError', 'Invalid "since" date'); return; }
  if (untilRaw && !dateRe.test(untilRaw)) { modalError('addPetError', 'Invalid "until" date'); return; }
  if (sinceRaw && untilRaw && sinceRaw > untilRaw) { modalError('addPetError', '"Since" must be before "until"'); return; }
  try {
    await api('/api/pets', { method: 'POST', body: { name, description, since: sinceRaw || null, until: untilRaw || null } });
    closeModal();
    await loadPets(true);
    await selectPet(name);
    toast(`Created ${name}`, 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

let _petToEdit = null;

function openEditPet(name) {
  _petToEdit = name;
  const p = pets.find(p => p.name === name);
  document.getElementById('editPetName').value = p.name;
  document.getElementById('editPetDescription').value = p.description || '';
  document.getElementById('editPetSince').value = p.since || '';
  document.getElementById('editPetUntil').value = p.until || '';
  document.getElementById('editPetModal').classList.add('open');
  setTimeout(() => document.getElementById('editPetName').focus(), 100);
}
function closeEditModal() { document.getElementById('editPetModal').classList.remove('open'); _petToEdit = null; }

async function submitEditPet() {
  if (!_petToEdit) return;
  const prevActiveName = activePet?.name;
  clearModalError('editPetError');
  const name = document.getElementById('editPetName').value.trim();
  if (!name) { modalError('editPetError', 'Name cannot be empty'); return; }
  const description = document.getElementById('editPetDescription').value.trim();
  if (!description) { modalError('editPetError', 'Description is required'); return; }
  const sinceRaw = document.getElementById('editPetSince').value;
  const untilRaw = document.getElementById('editPetUntil').value;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (sinceRaw && !dateRe.test(sinceRaw)) { modalError('editPetError', 'Invalid "since" date'); return; }
  if (untilRaw && !dateRe.test(untilRaw)) { modalError('editPetError', 'Invalid "until" date'); return; }
  if (sinceRaw && untilRaw && sinceRaw > untilRaw) { modalError('editPetError', '"Since" must be before "until"'); return; }
  try {
    await api(`/api/pets/${encodeURIComponent(_petToEdit)}`, { method: 'PATCH', body: { name, description, since: sinceRaw || null, until: untilRaw || null } });
    closeEditModal();
    activePet = null; clearSearch();
    await loadPets(true);
    const selectName = prevActiveName === _petToEdit ? name : (prevActiveName || pets[0]?.name);
    if (selectName) await selectPet(selectName);
    toast('Saved', 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

let _petToDelete = null;

function openDeletePet(name) {
  _petToDelete = name;
  document.getElementById('deleteWarningText').textContent =
    `"Delete from Immich too" removes the person and untags all tagged photos in Immich permanently.`;
  document.getElementById('deleteLocalOnlyText').textContent =
    `"Remove from Pet Tagger only" keeps ${name} in Immich with all tagged photos intact, but stops auto-tagging new photos. You can re-import it later.`;
  document.getElementById('resetImmichText').textContent =
    `"Untag all photos in Immich" removes all tags for ${name} in Immich and creates a fresh person, but keeps your reference images so you can start tagging again right away.`;
  document.getElementById('deletePetModal').classList.add('open');
}
function closeDeleteModal() { document.getElementById('deletePetModal').classList.remove('open'); _petToDelete = null; }

async function confirmDeletePet(localOnly) {
  if (!_petToDelete) return;
  const name = _petToDelete;
  closeDeleteModal();
  try {
    const url = `/api/pets/${encodeURIComponent(name)}` + (localOnly ? '?local_only=true' : '');
    await api(url, { method: 'DELETE' });
    if (activePet?.name === name) {
      activePet = null;
      document.getElementById('refsTitle').textContent = 'No pet selected';
      document.getElementById('refsGrid').innerHTML = '<div class="empty" style="grid-column:1/-1;height:200px;"><div class="empty-sub">Select a pet</div></div>';
    }
    await refreshState();
    toast(localOnly ? `Removed ${name} from Pet Tagger` : `Deleted ${name}. Immich will clean up faces in the background.`, 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

async function confirmResetPet() {
  if (!_petToDelete) return;
  const name = _petToDelete;
  closeDeleteModal();
  try {
    await api(`/api/pets/${encodeURIComponent(name)}/reset-immich`, { method: 'POST' });
    await refreshState();
    toast(`Reset ${name}: all Immich tags cleared, reference images preserved.`, 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Import from Immich
// ---------------------------------------------------------------------------

let _allImportPeople = [], _importSelectedPerson = null;

async function openImportPet() {
  _importSelectedPerson = null;
  _allImportPeople = [];
  document.getElementById('importSearch').value = '';
  document.getElementById('importPeopleGrid').innerHTML = '<div class="loading">Loading…</div>';
  clearModalError('importPickerError');
  document.getElementById('importPickerModal').classList.add('open');
  try {
    const d = await api('/api/immich-people');
    _allImportPeople = d.people || [];
    renderImportPeople(_allImportPeople);
  } catch(e) {
    document.getElementById('importPeopleGrid').innerHTML = `<div class="empty" style="grid-column:1/-1;padding:24px;"><div class="empty-sub">${e.message}</div></div>`;
  }
}

function renderImportPeople(people) {
  const grid = document.getElementById('importPeopleGrid');
  if (!people.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:24px;"><div class="empty-sub">No people found in Immich</div></div>';
    return;
  }
  const petPersonIds = new Set(pets.map(p => p.person_id).filter(Boolean));
  grid.innerHTML = people.map(p => `
    <div class="person-card${petPersonIds.has(p.id) ? ' already-added' : ''}" data-pid="${p.id}" onclick="handlePersonCardClick(this)">
      <img class="person-thumb" src="/api/person-thumb/${p.id}" onerror="this.style.opacity=0.2" loading="lazy" alt="">
      <span class="person-name-label">${p.name || '—'}</span>
    </div>`).join('');
}

function filterImportPeople() {
  const q = document.getElementById('importSearch').value.toLowerCase();
  renderImportPeople(q ? _allImportPeople.filter(p => (p.name || '').toLowerCase().includes(q)) : _allImportPeople);
}

function handlePersonCardClick(el) {
  const id = el.dataset.pid;
  const person = _allImportPeople.find(p => p.id === id);
  if (!person) return;
  _importSelectedPerson = person;
  document.getElementById('importPickerModal').classList.remove('open');
  document.getElementById('importPetName').value = person.name || '';
  document.getElementById('importPetDescription').value = '';
  document.getElementById('importPetSince').value = '';
  document.getElementById('importPetUntil').value = '';
  clearModalError('importDetailError');
  document.getElementById('importDetailModal').classList.add('open');
  setTimeout(() => document.getElementById('importPetDescription').focus(), 100);
}

function closeImportPicker() { document.getElementById('importPickerModal').classList.remove('open'); }
function closeImportDetail() { document.getElementById('importDetailModal').classList.remove('open'); _importSelectedPerson = null; }
function backToImportPicker() { document.getElementById('importDetailModal').classList.remove('open'); document.getElementById('importPickerModal').classList.add('open'); }

async function submitImportPet() {
  if (!_importSelectedPerson) return;
  clearModalError('importDetailError');
  const description = document.getElementById('importPetDescription').value.trim();
  if (!description) { modalError('importDetailError', 'Description is required'); return; }
  const sinceRaw = document.getElementById('importPetSince').value;
  const untilRaw = document.getElementById('importPetUntil').value;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (sinceRaw && !dateRe.test(sinceRaw)) { modalError('importDetailError', 'Invalid "since" date'); return; }
  if (untilRaw && !dateRe.test(untilRaw)) { modalError('importDetailError', 'Invalid "until" date'); return; }
  if (sinceRaw && untilRaw && sinceRaw > untilRaw) { modalError('importDetailError', '"Since" must be before "until"'); return; }
  try {
    const result = await api('/api/pets/import', { method: 'POST', body: {
      person_id: _importSelectedPerson.id,
      name: _importSelectedPerson.name,
      description,
      since: sinceRaw || null,
      until: untilRaw || null,
    }});
    closeImportDetail();
    await refreshState();
    await selectPet(result.name);
    toast(result.ref_count > 0 ? `Imported ${result.name} with ${result.ref_count} refs` : `Imported ${result.name} with 0 refs. No animals were detected in the reference photos. Add refs manually.`, result.ref_count > 0 ? 'success' : 'warn');
  } catch(e) { modalError('importDetailError', e.message); }
}

// ---------------------------------------------------------------------------
// Modal backdrop dismissal
// ---------------------------------------------------------------------------

document.getElementById('addPetModal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
document.getElementById('editPetModal').addEventListener('click', function(e) { if (e.target === this) closeEditModal(); });
document.getElementById('deletePetModal').addEventListener('click', function(e) { if (e.target === this) closeDeleteModal(); });
document.getElementById('importPickerModal').addEventListener('click', function(e) { if (e.target === this) closeImportPicker(); });
document.getElementById('importDetailModal').addEventListener('click', function(e) { if (e.target === this) closeImportDetail(); });
document.getElementById('inspectModal').addEventListener('click', function(e) { if (e.target === this) closeInspectModal(); });
document.addEventListener('keydown', function(e) {
  const modal = document.getElementById('inspectModal');
  if (!modal || !modal.classList.contains('open')) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateInspect(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigateInspect(1);
  }
});

// ---------------------------------------------------------------------------
// View Skipped Photos
// ---------------------------------------------------------------------------

function openViewSkipped() {
  if (!activePet) return;
  window.open(`/static/skipped.html?pet=${encodeURIComponent(activePet.name)}`, '_blank');
}

function openViewSkipAsRef() {
  if (!activePet) return;
  window.open(`/static/skip_as_ref.html?pet=${encodeURIComponent(activePet.name)}`, '_blank');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async () => {
  await refreshState();
  if (!activePet && pets.length > 0) showGuide();
  loadTimestamp();
  loadScanResult();
  api('/api/version').then(async d => {
    const el = document.getElementById('versionLabel');
    if (!el) return;
    const current = d.version;
    el.textContent = current;
    try {
      const CACHE_KEY = 'pet_tagger_latest_version';
      const CACHE_TTL = 3600 * 1000;
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      let latest = cached && (Date.now() - cached.ts < CACHE_TTL) ? cached.version : null;
      if (!latest) {
        const r = await fetch('https://api.github.com/repos/tedornitier/immich-pet-tagger/releases/latest');
        if (r.ok) {
          latest = (await r.json()).tag_name;
          localStorage.setItem(CACHE_KEY, JSON.stringify({ version: latest, ts: Date.now() }));
        }
      }
      if (latest && latest !== current) {
        el.innerHTML = `${current} <a href="https://github.com/tedornitier/immich-pet-tagger/releases/latest" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:600;" title="Update available: ${latest}">↑ update</a>`;
      }
    } catch(_) {}
  }).catch(() => {});
})();

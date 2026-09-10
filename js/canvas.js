/* =====================================================================
 * canvas.js —— 画布：节点、连线（区分亲生/非亲生/配偶线型）、
 * 拖拽、平移缩放、自动布局
 * ===================================================================== */
'use strict';

const viewport = document.getElementById('viewport');
const nodeLayer = document.getElementById('nodeLayer');
const edgeLayer = document.getElementById('edgeLayer');
const canvasWrap = document.getElementById('canvasWrap');

function applyView() {
  const { x, y, k } = state.view;
  viewport.style.transform = `translate(${x}px,${y}px) scale(${k})`;
  document.getElementById('zoomLabel').textContent = Math.round(k * 100) + '%';
}

/* ---------------- 可见性（筛选 + 折叠） ---------------- */
/** 被折叠支系隐藏掉的人物 id 集合（支系根本身不隐藏） */
function hiddenByCollapse() {
  const set = new Set();
  for (const id of Object.keys(state.collapsed)) {
    if (!state.collapsed[id]) continue;
    for (const m of branchMembers(id)) {
      if (m.id !== id) set.add(m.id);
    }
  }
  return set;
}

/** 节点是否可见：辈分筛选 + 所在支系是否折叠 */
function isVisible(p, hiddenSet) {
  if (state.genFilter !== 'all' && String(p.gen) !== String(state.genFilter)) return false;
  if ((hiddenSet || hiddenByCollapse()).has(p.id)) return false;
  return true;
}

/* ---------------- 渲染 ---------------- */
function renderCanvas() {
  nodeLayer.innerHTML = '';
  edgeLayer.innerHTML = '';
  document.getElementById('emptyHint').style.display = (state.people.length || state.draft) ? 'none' : 'flex';
  const hiddenSet = hiddenByCollapse();
  drawAllEdges(hiddenSet);

  for (const p of state.people) {
    if (!isVisible(p, hiddenSet)) continue;
    nodeLayer.appendChild(buildNode(p, hiddenSet));
  }
  // 草稿节点（尚未保存的新建人物）
  if (state.draft) {
    const d = state.draft;
    for (const e of (d.parents || [])) {
      const parent = byId(e.id);
      if (parent && isVisible(parent, hiddenSet)) edgeLayer.appendChild(buildEdge(parent, d, e.type));
    }
    nodeLayer.appendChild(buildNode(d, hiddenSet, true));
  }
  applyView();
}

/** 绘制全部边（亲子 + 配偶） */
function drawAllEdges(hiddenSet) {
  const drawn = new Set();
  const coupleDrawn = new Set();
  for (const p of state.people) {
    if (!isVisible(p, hiddenSet)) continue;
    for (const e of (p.parents || [])) {
      const parent = byId(e.id);
      if (!parent || !isVisible(parent, hiddenSet)) continue;
      const key = e.id + '->' + p.id + ':' + e.type;
      if (drawn.has(key)) continue;
      drawn.add(key);
      edgeLayer.appendChild(buildEdge(parent, p, e.type));
    }
  }
  // 配偶连线（显式 + 共同子女推定）
  for (const p of state.people) {
    if (!isVisible(p, hiddenSet)) continue;
    for (const { person: sp } of allPartnersOf(p.id)) {
      if (!isVisible(sp, hiddenSet)) continue;
      const key = [p.id, sp.id].sort().join('~');
      if (coupleDrawn.has(key)) continue;
      coupleDrawn.add(key);
      edgeLayer.appendChild(buildSpouseEdge(p, sp));
    }
  }
}

/** 亲子边：亲生实线，收养/继亲紫色虚线 */
function buildEdge(parent, child, type) {
  const x1 = (parent.x ?? 0) + NODE_W / 2;
  const y1 = (parent.y ?? 0) + NODE_H - 6;
  const x2 = (child.x ?? 0) + NODE_W / 2;
  const y2 = (child.y ?? 0) + 8;
  const my = (y1 + y2) / 2;
  const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'edge-path' + (type && type !== 'bio' ? ' nonbio' : ''));
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = `${parent.name || '未命名'} → ${child.name || '未命名'}（${relTypeLabel(type || 'bio')}）`;
  path.appendChild(title);
  return path;
}

/** 配偶边：粉色点线 */
function buildSpouseEdge(a, b) {
  const x1 = (a.x ?? 0) + NODE_W, y1 = (a.y ?? 0) + NODE_H / 2;
  const x2 = (b.x ?? 0), y2 = (b.y ?? 0) + NODE_H / 2;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', Math.min(x1, x2)); line.setAttribute('y1', y1);
  line.setAttribute('x2', Math.max(x1, x2)); line.setAttribute('y2', y2);
  line.setAttribute('class', 'edge-spouse');
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = `${a.name || '未命名'} ⚭ ${b.name || '未命名'}（配偶）`;
  line.appendChild(title);
  return line;
}

function buildNode(p, hiddenSet, isDraft = false) {
  const el = document.createElement('div');
  el.className = `node ${p.gender}${state.selectedId === p.id ? ' selected' : ''}${state.egoId === p.id ? ' is-ego' : ''}${isDraft ? ' draft' : ''}`;
  el.style.left = (p.x ?? 0) + 'px';
  el.style.top = (p.y ?? 0) + 'px';
  el.dataset.id = p.id;

  const collapsedHere = !isDraft && !!state.collapsed[p.id];
  const hiddenCount = collapsedHere
    ? branchMembers(p.id).filter(m => m.id !== p.id).length : 0;
  let termBadge = '';
  if (!isDraft && state.egoId && state.egoId !== p.id) {
    const ego = byId(state.egoId);
    const k = ego ? displayKinship(state.egoId, p.id) : null;
    if (k && k.tag !== '无关联') termBadge = `<span class="n-term${k.custom ? ' custom' : ''}" title="${esc(k.term)}${k.placeholder ? '（推导占位，可手工修正）' : ''}">${esc(k.term)}</span>`;
  }

  el.innerHTML = `
    <div class="n-actions">
      ${isDraft ? '' : '<div class="nact act-add" title="添加子女">＋</div>'}
      <div class="nact act-edit" title="编辑">✎</div>
    </div>
    ${hiddenCount > 0 ? `<div class="n-col-badge act-toggle" title="展开支系">${hiddenCount}<span style="margin-left:2px">▸</span></div>` : ''}
    <div class="n-name">
      <span class="dot ${p.gender}" style="width:8px;height:8px"></span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name || (isDraft ? '新人物（未保存）' : '未命名'))}</span>
      ${state.egoId === p.id ? '<span class="n-ego-badge">我</span>' : ''}
    </div>
    <div class="n-meta">第 ${p.gen ?? 0} 辈${(p.order >= 1) ? ` · 排行${p.order}` : ''}${isDraft ? ' · 草稿' : ''}</div>
    ${termBadge}
  `;

  if (!isDraft) el.addEventListener('dblclick', ev => {
    ev.stopPropagation();
    state.egoId = p.id;
    save(); renderAll();
    toast(`已将「${p.name}」设为称谓基准`);
  });
  el.querySelector('.act-edit').addEventListener('click', ev => {
    ev.stopPropagation();
    if (isDraft) openDraft(p); else openEditor(p.id);
  });
  const addBtn = el.querySelector('.act-add');
  if (addBtn) addBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    quickAddChild(p);
  });
  const tog = el.querySelector('.act-toggle');
  if (tog) tog.addEventListener('click', ev => {
    ev.stopPropagation();
    delete state.collapsed[p.id];
    save(); renderAll();
  });

  attachNodeDrag(el, p, isDraft);
  return el;
}

/* ---------------- 节点拖拽 ---------------- */
function attachNodeDrag(el, p, isDraft = false) {
  let sx, sy, ox, oy, dragging = false, moved = false;
  el.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.nact') || ev.target.closest('.n-col-badge')) return;
    if (ev.button !== 0) return;
    ev.stopPropagation();
    dragging = true; moved = false;
    sx = ev.clientX; sy = ev.clientY; ox = p.x ?? 0; oy = p.y ?? 0;
    el.setPointerCapture(ev.pointerId);
  });
  el.addEventListener('pointermove', ev => {
    if (!dragging) return;
    const dx = (ev.clientX - sx) / state.view.k;
    const dy = (ev.clientY - sy) / state.view.k;
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) moved = true;
    p.x = ox + dx; p.y = oy + dy;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    edgeLayer.innerHTML = '';
    drawAllEdges(hiddenByCollapse());
  });
  const end = ev => {
    if (!dragging) return;
    dragging = false;
    if (moved) { if (!isDraft) save(); }
    else if (!isDraft) selectPerson(p.id);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function selectPerson(id) {
  state.selectedId = id;
  state.tab = 'people';
  // 轻量更新选中态，不重建节点元素——否则双击的第二次点击会落到
  // 新元素上，dblclick 永远无法触发（双击设基准会失效）
  nodeLayer.querySelectorAll('.node').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderSidebar();
  syncEgoChip();
}

/* ---------------- 画布平移/缩放 ---------------- */
let panState = null;
canvasWrap.addEventListener('pointerdown', ev => {
  if (ev.target.closest('.node')) return;
  panState = { sx: ev.clientX, sy: ev.clientY, ox: state.view.x, oy: state.view.y };
  canvasWrap.classList.add('panning');
  canvasWrap.setPointerCapture(ev.pointerId);
  if (ev.target === canvasWrap || ev.target.id === 'viewport' || ev.target.id === 'edgeLayer') {
    if (state.draft) { state.draft = null; }
    state.selectedId = null;
    renderAll();
  }
});
canvasWrap.addEventListener('pointermove', ev => {
  if (!panState) return;
  state.view.x = panState.ox + (ev.clientX - panState.sx);
  state.view.y = panState.oy + (ev.clientY - panState.sy);
  applyView();
});
canvasWrap.addEventListener('pointerup', () => { panState = null; canvasWrap.classList.remove('panning'); });
canvasWrap.addEventListener('pointercancel', () => { panState = null; canvasWrap.classList.remove('panning'); });

canvasWrap.addEventListener('wheel', ev => {
  ev.preventDefault();
  const rect = canvasWrap.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const oldK = state.view.k;
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  const k = Math.min(2.2, Math.max(0.25, oldK * factor));
  state.view.x = mx - (mx - state.view.x) * (k / oldK);
  state.view.y = my - (my - state.view.y) * (k / oldK);
  state.view.k = k;
  applyView();
  save();
}, { passive: false });

function zoomBy(f) {
  const rect = canvasWrap.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;
  const oldK = state.view.k, k = Math.min(2.2, Math.max(0.25, oldK * f));
  state.view.x = mx - (mx - state.view.x) * (k / oldK);
  state.view.y = my - (my - state.view.y) * (k / oldK);
  state.view.k = k;
  applyView(); save();
}

function fitView(pad = 60) {
  const hiddenSet = hiddenByCollapse();
  const vis = state.people.filter(p => isVisible(p, hiddenSet));
  if (!vis.length) { state.view = { x: 60, y: 40, k: 1 }; applyView(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of vis) {
    minX = Math.min(minX, p.x ?? 0); minY = Math.min(minY, p.y ?? 0);
    maxX = Math.max(maxX, (p.x ?? 0) + NODE_W); maxY = Math.max(maxY, (p.y ?? 0) + NODE_H);
  }
  const rect = canvasWrap.getBoundingClientRect();
  const k = Math.min(1.5, Math.max(0.25,
    Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY))));
  state.view.k = k;
  state.view.x = (rect.width - (maxX - minX) * k) / 2 - minX * k;
  state.view.y = (rect.height - (maxY - minY) * k) / 2 - minY * k;
  applyView(); save();
}

/* =====================================================================
 * 自动布局：按支系 BFS 排列，辈分决定纵坐标
 * ===================================================================== */
function autoLayout() {
  const rs = roots();
  if (!rs.length) {
    state.people.forEach((p, i) => { p.x = 60 + i * 180; p.y = 60; });
    renderCanvas(); return;
  }
  let cursorX = 40;
  const topY = 40;
  const placed = new Set(); // 跨支系共享，避免配偶被两支重复放置
  for (const r of rs) {
    if (placed.has(r.id)) continue;
    const res = layoutFamily(r, cursorX, topY, placed);
    cursorX = res.maxX + 110;
  }
  // 兜底：任何未被布局覆盖的（环中的孤立成员）
  let fx = cursorX;
  for (const p of state.people) {
    if (!placed.has(p.id)) { p.x = fx; p.y = topY; fx += NODE_W + SIB_GAP; }
  }
  save();
  renderCanvas();
  setTimeout(() => fitView(), 30);
}

/** 本次布局中 head 应同层放置的配偶（有父母的配偶归属其本家，不重复占位） */
function layoutSpouseOf(head, placed) {
  for (const { person: sp } of allPartnersOf(head.id)) {
    if (placed.has(sp.id)) continue;
    const spHomeless = !(sp.parents || []).length;
    const headHomeless = !(head.parents || []).length;
    if (spHomeless || headHomeless) return sp;
  }
  return null;
}

/** 以“核心家庭”为单元递归布局，自底向上计算子树宽度并居中 */
function layoutFamily(head, startX, topY, placed) {
  if (!head || placed.has(head.id)) return { maxX: startX };
  placed.add(head.id);

  // head 的配偶放同一层
  let spouse = layoutSpouseOf(head, placed);
  if (spouse) placed.add(spouse.id);

  // 以 head（及配偶）为父母的子女，按出生顺序
  const kids = state.people
    .filter(c => (c.parents || []).some(e => e.id === head.id || (spouse && e.id === spouse.id)))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  // 先递归排子女家庭，累计宽度
  const blocks = [];
  let totalW = 0;
  for (const k of kids) {
    const subW = measureFamily(k, placed);
    const begin = startX + totalW;
    const res = layoutFamily(k, begin, topY + GEN_GAP, placed);
    blocks.push({ kid: k, x: begin, w: subW, maxX: res.maxX });
    totalW += subW + (blocks.length > 1 ? SIB_GAP : 0);
  }

  // 本层夫妇占据宽度
  const selfW = spouse ? NODE_W * 2 + COUPLE_GAP : NODE_W;
  const blockW = Math.max(selfW, totalW);
  const baseX = startX + (blockW - selfW) / 2;
  head.x = baseX;
  head.y = topY;
  if (spouse) {
    spouse.x = baseX + NODE_W + COUPLE_GAP;
    spouse.y = topY;
  }

  let maxX = startX + blockW;
  for (const b of blocks) maxX = Math.max(maxX, b.maxX);
  return { maxX };
}

/** 只测量家庭子树宽度（用于父代居中），不写坐标；placed 与主布局共享 */
function measureFamily(head, placedGlobal) {
  const local = new Set();
  const walk = (h) => {
    if (local.has(h.id)) return 0;
    local.add(h.id);
    const spouse = layoutSpouseOf(h, new Set([...local, ...placedGlobal]));
    if (spouse) local.add(spouse.id);
    const kids = state.people
      .filter(c => (c.parents || []).some(e => e.id === h.id || (spouse && e.id === spouse.id)))
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    let kidsW = 0;
    kids.forEach((k, i) => {
      if (i > 0) kidsW += SIB_GAP;
      kidsW += walk(k);
    });
    const selfW = spouse ? NODE_W * 2 + COUPLE_GAP : NODE_W;
    return Math.max(selfW, kidsW);
  };
  return walk(head);
}

/** 确保节点可见：展开包含它的折叠支系、必要时重置辈分筛选 */
function revealNode(id) {
  const p = byId(id);
  if (!p) return;
  let changed = false;
  for (const rootId of Object.keys(state.collapsed)) {
    if (state.collapsed[rootId] && branchMembers(rootId).some(m => m.id === id)) {
      delete state.collapsed[rootId]; changed = true;
    }
  }
  if (state.genFilter !== 'all' && String(p.gen) !== String(state.genFilter)) {
    state.genFilter = 'all'; changed = true;
  }
  if (changed) { renderGenFilter(); save(); }
}

function panToNode(id) {
  const p = byId(id);
  if (!p) return;
  const rect = canvasWrap.getBoundingClientRect();
  state.view.x = rect.width / 2 - (p.x + NODE_W / 2) * state.view.k;
  state.view.y = rect.height / 2 - (p.y + NODE_H / 2) * state.view.k;
  applyView(); save();
}

/** 在画布上定位人物：解除折叠/筛选、选中并平移过去 */
function locatePerson(id) {
  revealNode(id);
  state.selectedId = id;
  renderAll();
  panToNode(id);
}

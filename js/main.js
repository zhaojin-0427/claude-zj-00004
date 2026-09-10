/* =====================================================================
 * main.js —— 统一渲染、事件绑定与启动
 * ===================================================================== */
'use strict';

/* ---------------- 辈分筛选 ---------------- */
function renderGenFilter() {
  const sel = document.getElementById('genFilter');
  const gens = [...new Set(state.people.map(p => p.gen ?? 0))].sort((a, b) => a - b);
  const cur = state.genFilter;
  sel.innerHTML = `<option value="all">全部辈分</option>` +
    gens.map(g => `<option value="${g}" ${String(cur) === String(g) ? 'selected' : ''}>第 ${g} 辈</option>`).join('');
}

/* ---------------- 统一渲染 ---------------- */
function renderAll() {
  invalidateGraph();   // 称谓推导的邻接缓存
  invalidateIssues();  // 校验结果缓存
  renderGenFilter();
  renderCanvas();
  renderSidebar();
  syncEgoChip();
}

function syncEgoChip() {
  const chip = document.getElementById('egoChip');
  const ego = state.egoId ? byId(state.egoId) : null;
  chip.style.display = ego ? 'flex' : 'none';
  if (ego) document.getElementById('egoName').textContent = ego.name || '未命名';
}

/* ---------------- 事件绑定 ---------------- */
document.getElementById('btnAdd').addEventListener('click', addPerson);
document.getElementById('btnLayout').addEventListener('click', () => { autoLayout(); });
document.getElementById('btnFit').addEventListener('click', () => fitView());
document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(1.15));
document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.15));
document.getElementById('btnExportJson').addEventListener('click', exportJSON);
document.getElementById('btnExportPng').addEventListener('click', exportPNG);
document.getElementById('btnSample').addEventListener('click', () => loadSample(false));
document.getElementById('btnImportJson').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) importJSON(f);
  e.target.value = '';
});
document.getElementById('genFilter').addEventListener('change', e => {
  state.genFilter = e.target.value; save(); renderCanvas();
});
document.querySelectorAll('#tabs .tab').forEach(t => {
  t.addEventListener('click', () => {
    // 切离“人物”表单时放弃未保存的新建草稿
    if (state.draft && t.dataset.tab !== 'people') { state.draft = null; state.selectedId = null; }
    state.tab = t.dataset.tab; state._kinEdit = null; renderAll();
  });
});
document.getElementById('egoClear').addEventListener('click', () => {
  state.egoId = null; save(); renderAll();
});
document.getElementById('btnClear').addEventListener('click', async () => {
  if (!state.people.length) { toast('画布已是空的'); return; }
  const ok = await confirmModal('清空全部数据', '将删除所有人物、称谓修正与布局，且无法恢复。确定吗？');
  if (!ok) return;
  state.people = []; state.customTerms = {}; state.collapsed = {};
  state.egoId = null; state.selectedId = null; state.genFilter = 'all'; state.draft = null;
  localStorage.removeItem(STORAGE_KEY);
  renderGenFilter(); renderAll();
  toast('已清空');
});
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state.draft) state.draft = null;
    state.selectedId = null; state._kinEdit = null; renderAll();
  }
});

/* ---------------- 启动 ---------------- */
(function init() {
  load();
  renderGenFilter();
  renderAll();
  applyView();
})();

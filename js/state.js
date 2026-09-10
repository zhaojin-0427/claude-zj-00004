/* =====================================================================
 * state.js —— 全局状态与 localStorage 持久化（含旧格式迁移）
 *
 * 人物数据模型（v2）：
 *   {
 *     id, name, gen, gender, order, note, x, y,
 *     parents: [{ id, role: 'father'|'mother', type: 'bio'|'adopt'|'step' }],
 *     spouses: [id, ...]               // 显式配偶关系（双向冗余存储）
 *   }
 * 旧格式（v1）的 fatherId / motherId 会在加载与导入时迁移为 parents 条目。
 * ===================================================================== */
'use strict';

let state = {
  people: [],
  customTerms: {},          // { "egoId>>targetId": { term, note } } 手工称谓修正
  collapsed: {},            // { rootId: true } 支系折叠
  egoId: null,              // 称谓基准（“我”）
  view: { x: 60, y: 40, k: 1 },
  genFilter: 'all',
  tab: 'people',
  selectedId: null,
  draft: null,              // 尚未保存的新建人物（保存前不入 people / localStorage）
  _kinEdit: null,           // 称谓面板中正在编辑的 key
};

/** 把任意来源的人物记录规范化为 v2 模型（就地修改并返回） */
function migratePerson(p) {
  if (!Array.isArray(p.parents)) {
    p.parents = [];
    // 兼容 v1：fatherId / motherId 视为亲生父母
    if (p.fatherId) p.parents.push({ id: p.fatherId, role: 'father', type: 'bio' });
    if (p.motherId) p.parents.push({ id: p.motherId, role: 'mother', type: 'bio' });
  }
  delete p.fatherId;
  delete p.motherId;
  p.parents = p.parents
    .filter(e => e && e.id)
    .map(e => ({
      id: e.id,
      role: e.role === 'mother' ? 'mother' : 'father',
      type: ['bio', 'adopt', 'step'].includes(e.type) ? e.type : 'bio',
    }));
  if (!Array.isArray(p.spouses)) p.spouses = [];
  p.spouses = [...new Set(p.spouses.filter(Boolean))];
  p.name = p.name ?? '';
  p.gen = Number.isFinite(p.gen) ? p.gen : 0;
  p.gender = ['male', 'female', 'unknown'].includes(p.gender) ? p.gender : 'unknown';
  p.order = Number.isFinite(p.order) ? p.order : null;
  p.note = p.note ?? '';
  p.x = Number.isFinite(p.x) ? p.x : 40;
  p.y = Number.isFinite(p.y) ? p.y : 40;
  return p;
}

/** 全库规范化：清理悬空引用、保证配偶关系双向对称。
 *  注意：自我引用（自己是自己的父母/配偶）不在此清除，留给校验器报告。 */
function normalizePeople(people) {
  const ids = new Set(people.map(p => p.id));
  for (const p of people) {
    p.parents = p.parents.filter(e => ids.has(e.id));
    p.spouses = p.spouses.filter(s => ids.has(s));
  }
  // 配偶关系对称化：A 列出 B 则 B 也列出 A
  for (const p of people) {
    for (const s of p.spouses) {
      const sp = people.find(x => x.id === s);
      if (sp && !sp.spouses.includes(p.id)) sp.spouses.push(p.id);
    }
  }
  return people;
}

function save() {
  try {
    const persist = {
      version: STORAGE_VERSION,
      people: state.people,
      customTerms: state.customTerms,
      collapsed: state.collapsed,
      egoId: state.egoId,
      view: state.view,
      genFilter: state.genFilter,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
  } catch (e) { console.warn('保存失败', e); }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    state.people = normalizePeople((d.people || []).map(migratePerson));
    state.customTerms = d.customTerms || {};
    state.collapsed = d.collapsed || {};
    state.egoId = d.egoId || null;
    if (state.egoId && !state.people.some(p => p.id === state.egoId)) state.egoId = null;
    if (d.view) state.view = d.view;
    state.genFilter = d.genFilter || 'all';
    return state.people.length > 0;
  } catch (e) { return false; }
}

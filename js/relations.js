/* =====================================================================
 * relations.js —— 关系图模型查询
 * 边类型：亲子（亲生/收养/继亲，有向）、配偶（显式 + 共同子女推定，无向）
 * ===================================================================== */
'use strict';

const byId = id => state.people.find(p => p.id === id) || null;
const nameOf = id => { const p = byId(id); return p ? (p.name || '未命名') : '?'; };

/** 父母条目（含解析后的人物对象） */
function parentEntriesOf(p) {
  return (p.parents || [])
    .map(e => ({ ...e, person: byId(e.id) }))
    .filter(e => e.person);
}
function parentsOf(p) {
  return parentEntriesOf(p).map(e => e.person);
}
/** 子女（本人出现在其 parents 中的人物），按出生顺序排序 */
function childrenOf(id) {
  return state.people.filter(p => (p.parents || []).some(e => e.id === id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
/** parentId 与 childId 之间的亲子类型（'bio'|'adopt'|'step'|null） */
function linkTypeBetween(parentId, childId) {
  const c = byId(childId);
  const e = c && (c.parents || []).find(x => x.id === parentId);
  return e ? e.type : null;
}

/** 显式配偶（解析后） */
function spousesOf(id) {
  const p = byId(id);
  if (!p) return [];
  return (p.spouses || []).map(byId).filter(Boolean);
}

/** 因共同子女推定的伴侣。
 *  规则：孩子恰为「唯一父槽 × 唯一母槽」时推定二人为伴侣；
 *  家长更多时（如另有养父/继母），只把同类型的对槽家长配成伴侣
 *  （亲生父×亲生母、养父×养母），避免把亲生父亲与养母等误配为配偶。 */
function coParentPartnersOf(id) {
  const out = [];
  const seen = new Set();
  for (const c of childrenOf(id)) {
    const myEntry = c.parents.find(e => e.id === id);
    if (!myEntry) continue;
    const fathers = c.parents.filter(e => e.role === 'father' && byId(e.id));
    const mothers = c.parents.filter(e => e.role === 'mother' && byId(e.id));
    let other = null;
    if (fathers.length === 1 && mothers.length === 1) {
      other = myEntry.role === 'father' ? mothers[0] : fathers[0];
    } else {
      const opposites = myEntry.role === 'father' ? mothers : fathers;
      other = opposites.find(e => e.type === myEntry.type) || null;
    }
    if (other && !seen.has(other.id)) {
      seen.add(other.id);
      out.push({ person: byId(other.id), child: c });
    }
  }
  return out;
}

/**
 * 全部伴侣：显式配偶优先，其次共同子女推定。
 * 返回 [{ person, via: 'explicit'|'child', child? }]
 */
function allPartnersOf(id) {
  const out = [];
  const seen = new Set();
  for (const sp of spousesOf(id)) {
    if (!seen.has(sp.id)) { seen.add(sp.id); out.push({ person: sp, via: 'explicit' }); }
  }
  for (const cp of coParentPartnersOf(id)) {
    if (!seen.has(cp.person.id)) { seen.add(cp.person.id); out.push({ person: cp.person, via: 'child', child: cp.child }); }
  }
  return out;
}

/** 建立/解除显式配偶关系（双向同步） */
function linkSpouses(aId, bId) {
  const a = byId(aId), b = byId(bId);
  if (!a || !b || aId === bId) return;
  if (!a.spouses.includes(bId)) a.spouses.push(bId);
  if (!b.spouses.includes(aId)) b.spouses.push(aId);
}
function unlinkSpouses(aId, bId) {
  const a = byId(aId), b = byId(bId);
  if (a) a.spouses = a.spouses.filter(s => s !== bId);
  if (b) b.spouses = b.spouses.filter(s => s !== aId);
}

/* ---------------- 支系 ---------------- */
/** 无父母记录者为根；无父母的配偶并入对方支系，不单独成支 */
function isRoot(p) {
  if ((p.parents || []).length) return false;
  const partners = allPartnersOf(p.id).map(x => x.person);
  // 任一伴侣有父母 → 本人作为配偶并入对方支系
  if (partners.some(sp => (sp.parents || []).length)) return false;
  // 双方都无父母：男性优先作为支系代表，同性别按 id 稳定取一
  const group = [p, ...partners];
  const males = group.filter(x => x.gender === 'male');
  const rep = (males.length ? males : group).slice().sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  return rep.id === p.id;
}
function roots() {
  return state.people.filter(isRoot)
    .sort((a, b) => (a.gen ?? 0) - (b.gen ?? 0) || (a.order ?? 0) - (b.order ?? 0));
}
/** 支系全部成员：后代 + 各代成员无父母记录的伴侣 */
function branchMembers(id) {
  const root = byId(id);
  if (!root) return [];
  const acc = [root];
  const queue = [id];
  const seen = new Set([id]);
  const mergeHomelessPartner = (pid) => {
    for (const { person: sp } of allPartnersOf(pid)) {
      if (!seen.has(sp.id) && !(sp.parents || []).length) {
        seen.add(sp.id); acc.push(sp);
      }
    }
  };
  while (queue.length) {
    const cur = queue.shift();
    for (const c of childrenOf(cur)) {
      if (!seen.has(c.id)) { seen.add(c.id); acc.push(c); queue.push(c.id); }
      // 孩子的其他家长，若无父母录入则作为配偶并入本支
      for (const e of c.parents) {
        if (seen.has(e.id)) continue;
        const pp = byId(e.id);
        if (pp && !(pp.parents || []).length) { seen.add(e.id); acc.push(pp); }
      }
    }
    mergeHomelessPartner(cur);
  }
  return acc;
}

/* ---------------- 上溯 / 后代 ---------------- */
/** 沿父母边上溯 BFS（父槽优先入队），返回 { dist, prev }；带访问集，循环安全 */
function bfsUp(from) {
  const dist = new Map(), prev = new Map();
  const q = [from];
  dist.set(from, 0);
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    const p = byId(cur);
    if (!p) continue;
    const entries = parentEntriesOf(p)
      .sort((a, b) => (a.role === b.role ? 0 : a.role === 'father' ? -1 : 1));
    for (const e of entries) {
      if (!dist.has(e.id)) { dist.set(e.id, dist.get(cur) + 1); prev.set(e.id, cur); q.push(e.id); }
    }
  }
  return { dist, prev };
}

/** 后代 id 集合（含自身）：编辑时禁止把后代选为父母（防环） */
function descendantSet(id) {
  const set = new Set([id]);
  let added = true;
  while (added) {
    added = false;
    for (const p of state.people) {
      if (!set.has(p.id) && (p.parents || []).some(e => set.has(e.id))) {
        set.add(p.id); added = true;
      }
    }
  }
  return set;
}

/** 祖先 id 集合（不含自身） */
function ancestorSet(id) {
  const set = new Set();
  const q = [id];
  const seen = new Set([id]);
  while (q.length) {
    const cur = byId(q.shift());
    if (!cur) continue;
    for (const e of parentEntriesOf(cur)) {
      if (!seen.has(e.id)) { seen.add(e.id); set.add(e.id); q.push(e.id); }
    }
  }
  return set;
}

/** 排行比较：a 为长返回 1，b 为长返回 -1，平/未知返回 0 */
function seniority(a, b) {
  if (!a || !b) return 0;
  const oa = a.order ?? 9999, ob = b.order ?? 9999;
  if (oa === ob) return 0;
  return oa < ob ? 1 : -1;
}

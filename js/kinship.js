/* =====================================================================
 * kinship.js —— 称谓推导引擎（类型化路径）
 *
 * 图模型：
 *   亲子边（up/down，类型 亲生/收养/继亲）+ 配偶边（显式或共同子女推定）。
 * 路径搜索：
 *   Dijkstra，代价为 (路径最高边权, 步数, 配偶边数) 字典序。
 *   边权：亲生=0 收养=1 继亲=2 配偶=3 —— 因此血缘路径永远优先，
 *   血缘内部再取最短；无血缘时依次偏好收养、继亲，最后才是姻亲路径。
 * 路径归一：
 *   “先下后上”（经共同子女绕到孩子另一位家长）归并为一步配偶边。
 * 推导：
 *   无配偶边 → 血亲称谓表（养/继路径加类型前缀，旁系给占位称谓）；
 *   有配偶边 → 姻亲称谓表（岳家/夫家/继亲/叔伯母舅母等），
 *   无法确定的传统称谓 → 带关系类型的占位称谓，保留手工修正。
 * ===================================================================== */
'use strict';

/* ---------------- 邻接图（带缓存） ---------------- */
let _adjCache = null;
function invalidateGraph() { _adjCache = null; }

const EDGE_RANK = { bio: 0, adopt: 1, step: 2, spouse: 3 };

function getAdj() {
  if (_adjCache) return _adjCache;
  const adj = new Map();
  const add = (from, e) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(e);
  };
  for (const p of state.people) {
    for (const e of (p.parents || [])) {
      if (!byId(e.id)) continue;
      const rank = EDGE_RANK[e.type] ?? 0;
      add(p.id, { to: e.id, kind: 'up', type: e.type, rank });
      add(e.id, { to: p.id, kind: 'down', type: e.type, rank });
    }
  }
  // 配偶边：显式 + 共同子女推定（排除互为祖先/后代的异常数据）
  const ancCache = new Map();
  const ancOf = id => {
    if (!ancCache.has(id)) ancCache.set(id, bfsUp(id).dist);
    return ancCache.get(id);
  };
  const pairs = new Set();
  for (const p of state.people) {
    for (const sp of spousesOf(p.id)) pairs.add([p.id, sp.id].sort().join('~'));
    for (const cp of coParentPartnersOf(p.id)) {
      if (ancOf(p.id).has(cp.person.id) || ancOf(cp.person.id).has(p.id)) continue;
      pairs.add([p.id, cp.person.id].sort().join('~'));
    }
  }
  for (const key of pairs) {
    const [a, b] = key.split('~');
    add(a, { to: b, kind: 'spouse', type: null, rank: EDGE_RANK.spouse });
    add(b, { to: a, kind: 'spouse', type: null, rank: EDGE_RANK.spouse });
  }
  _adjCache = adj;
  return adj;
}

/* ---------------- 最短类型化路径 ---------------- */
function costBetter(c1, c2) {
  return c1[0] !== c2[0] ? c1[0] < c2[0]
    : c1[1] !== c2[1] ? c1[1] < c2[1]
    : c1[2] < c2[2];
}

/** 返回 from→to 的最优路径步骤 [{to, kind, type}]，不连通返回 null */
function bestPath(fromId, toId) {
  const adj = getAdj();
  const dist = new Map([[fromId, [0, 0, 0]]]);
  const prev = new Map();
  const pq = [{ id: fromId, cost: [0, 0, 0] }];
  while (pq.length) {
    let mi = 0;
    for (let i = 1; i < pq.length; i++) if (costBetter(pq[i].cost, pq[mi].cost)) mi = i;
    const { id, cost } = pq.splice(mi, 1)[0];
    if (costBetter(dist.get(id), cost)) continue; // 过期堆元素
    if (id === toId) break;
    for (const e of (adj.get(id) || [])) {
      const nc = [Math.max(cost[0], e.rank), cost[1] + 1, cost[2] + (e.kind === 'spouse' ? 1 : 0)];
      if (!dist.has(e.to) || costBetter(nc, dist.get(e.to))) {
        dist.set(e.to, nc);
        prev.set(e.to, { from: id, step: { to: e.to, kind: e.kind, type: e.type } });
        pq.push({ id: e.to, cost: nc });
      }
    }
  }
  if (fromId !== toId && !prev.has(toId)) return null;
  const steps = [];
  let cur = toId;
  while (cur !== fromId) {
    const pr = prev.get(cur);
    if (!pr) return null;
    steps.unshift(pr.step);
    cur = pr.from;
  }
  return steps;
}

/** 归一化：把“先下后上”（经共同子女绕道）折叠为一步配偶边 */
function normalizeSteps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === 'down' && i + 1 < steps.length && steps[i + 1].kind === 'up') {
      out.push({ to: steps[i + 1].to, kind: 'spouse', type: null });
      i++;
    } else {
      out.push(s);
    }
  }
  return out;
}

/** 路径涉及的非亲生类型 */
function typedInfo(steps) {
  return {
    hasAdopt: steps.some(s => s.type === 'adopt'),
    hasStep: steps.some(s => s.type === 'step'),
  };
}

/** 可读推导路径：我（李文）─父亲·亲生→ 李建国 ─配偶→ 赵淑芬 */
function renderPath(egoId, steps) {
  let s = `我（${nameOf(egoId)}）`;
  for (const st of steps) {
    const tp = byId(st.to);
    let label;
    if (st.kind === 'spouse') {
      label = '配偶';
    } else {
      const g = tp ? tp.gender : 'unknown';
      const role = st.kind === 'up'
        ? (g === 'female' ? '母亲' : g === 'male' ? '父亲' : '父母')
        : (g === 'female' ? '女儿' : g === 'male' ? '儿子' : '子女');
      label = `${role}·${relTypeLabel(st.type)}`;
    }
    s += ` ─${label}→ ${nameOf(st.to)}`;
  }
  return s;
}

/* ---------------- 基础称谓工具 ---------------- */
// sen>0：我为长，对方偏幼 → 称“弟/妹”；sen<0：对方为长 → 称“兄/姐”
function elderSuffix(sen) { return sen > 0 ? '弟' : sen < 0 ? '兄' : '兄弟'; }
function femaleElderSuffix(sen) { return sen > 0 ? '妹' : sen < 0 ? '姐' : '姐妹'; }
function neutralSiblingSuffix(sen) { return sen > 0 ? '弟/妹' : sen < 0 ? '兄/姐' : '兄弟姐妹'; }
function siblingTerm(gender, sen) {
  if (gender === 'female') return femaleElderSuffix(sen);
  if (gender === 'male') return elderSuffix(sen);
  return neutralSiblingSuffix(sen);
}

/**
 * 旁系长幼：同辈比本人出生顺序；异辈比共同祖先下两侧连接人的排行。
 * 返回 1 = ego 支系为长；-1 反之；0 未知。
 */
function collateralSeniority(ego, target, pathA, pathB, a, b) {
  if (a === b) return seniority(ego, target);
  const ca = pathA[a - 1], cb = pathB[b - 1]; // LCA 的两个子女
  return seniority(ca ? byId(ca) : null, cb ? byId(cb) : null);
}

/* ---------------- 血亲称谓表（不含配偶边） ---------------- */
/**
 * 由无配偶边的归一化路径推导基础称谓。
 * 返回 { term, tag, placeholder, a, b, pathA, pathB }
 */
function baseFamilyTerm(ego, target, steps) {
  const a = steps.filter(s => s.kind === 'up').length;
  const b = steps.filter(s => s.kind === 'down').length;
  const nodes = [ego.id, ...steps.map(s => s.to)];
  const pathA = nodes.slice(0, a + 1);           // ego → 共同祖先
  const pathB = nodes.slice(a).reverse();        // target → 共同祖先
  const tg = target.gender;

  /* ---- 目标是 ego 的祖先 ---- */
  if (b === 0) {
    const n = a;
    let term;
    if (n === 1) term = tg === 'female' ? '母亲' : tg === 'male' ? '父亲' : '父/母';
    else {
      const base = tg === 'female' ? '祖母' : tg === 'male' ? '祖父' : '祖父母';
      term = '曾'.repeat(Math.max(0, n - 2)) + base;
      // 经母亲上溯到的祖辈为外祖父母
      if (n === 2) {
        const stepP = byId(pathA[1]);
        if (stepP && stepP.gender === 'female')
          term = tg === 'female' ? '外祖母' : tg === 'male' ? '外祖父' : '外祖父母';
      }
    }
    return { term, tag: n >= 2 ? '祖孙' : '直系', placeholder: tg === 'unknown' && n === 1, a, b, pathA, pathB };
  }
  /* ---- ego 是目标的祖先 ---- */
  if (a === 0) {
    const n = b;
    const stepP = byId(pathB[1]); // target 的直接父/母
    const viaMother = stepP && stepP.gender === 'female';
    let term;
    if (n === 1) term = tg === 'female' ? '女儿' : tg === 'male' ? '儿子' : '孩子';
    else if (n === 2) {
      const outer = viaMother ? '外' : '';
      term = tg === 'female' ? outer + '孙女' : tg === 'male' ? outer + '孙子' : outer + '孙辈';
    } else {
      term = '曾' + (tg === 'female' ? '孙女' : tg === 'male' ? '孙' : '孙辈');
    }
    return { term, tag: n >= 2 ? '祖孙' : '直系', placeholder: tg === 'unknown', a, b, pathA, pathB };
  }

  const sen = collateralSeniority(ego, target, pathA, pathB, a, b);
  const linkA = pathA[1] ? byId(pathA[1]) : null; // ego 侧上溯连接人
  const linkB = pathB[1] ? byId(pathB[1]) : null; // target 侧上溯连接人
  // 父系一脉：共同祖先之下两侧连接人全部为男性
  const maleLine = pathA.length >= 2 && pathB.length >= 2
    && pathA.slice(1).every(id => byId(id) && byId(id).gender === 'male')
    && pathB.slice(1).every(id => byId(id) && byId(id).gender === 'male');
  const prefix = maleLine ? '堂' : '表';

  /* ---- 兄弟姐妹 ---- */
  if (a === 1 && b === 1) return { term: siblingTerm(tg, sen), tag: '兄弟姐妹', placeholder: tg === 'unknown', a, b, pathA, pathB };

  /* ---- (2,1) 父母辈：伯/叔/姑 vs 舅/姨 ---- */
  if (a === 2 && b === 1) {
    if (linkA && linkA.gender === 'female') {
      if (tg === 'female') return { term: '姨母', tag: '叔侄', a, b, pathA, pathB };
      if (tg === 'male') return { term: '舅父', tag: '叔侄', a, b, pathA, pathB };
      return { term: '舅/姨', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
    }
    if (tg === 'female') return { term: '姑母', tag: '叔侄', a, b, pathA, pathB };
    if (tg === 'male') return { term: sen > 0 ? '叔父' : sen < 0 ? '伯父' : '伯/叔父', tag: '叔侄', placeholder: sen === 0, a, b, pathA, pathB };
    return { term: sen > 0 ? '叔/姑' : sen < 0 ? '伯/姑' : '伯/叔/姑', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
  }

  /* ---- (1,2) 子女辈：侄/甥 ---- */
  if (a === 1 && b === 2) {
    if (linkB && linkB.gender === 'female') {
      if (tg === 'female') return { term: '甥女', tag: '叔侄', a, b, pathA, pathB };
      if (tg === 'male') return { term: '外甥', tag: '叔侄', a, b, pathA, pathB };
      return { term: '甥/甥女', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
    }
    if (tg === 'female') return { term: '侄女', tag: '叔侄', a, b, pathA, pathB };
    if (tg === 'male') return { term: '侄子', tag: '叔侄', a, b, pathA, pathB };
    return { term: '侄/侄女', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
  }

  /* ---- (2,2) 堂/表兄弟姐妹 ---- */
  if (a === 2 && b === 2)
    return { term: prefix + siblingTerm(tg, sen), tag: maleLine ? '堂亲' : '表亲', placeholder: tg === 'unknown', a, b, pathA, pathB };

  /* ---- (3,2) 父母的堂/表兄弟姐妹 ---- */
  if (a === 3 && b === 2) {
    if (tg === 'female') return { term: prefix + '姑', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
    if (tg === 'male') return { term: prefix + (sen > 0 ? '叔' : sen < 0 ? '伯' : '伯/叔'), tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
    return { term: prefix + '伯/叔/姑', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
  }

  /* ---- (2,3) 堂/表兄弟姐妹之子女 ---- */
  if (a === 2 && b === 3) {
    if (linkB && linkB.gender === 'female') {
      if (tg === 'female') return { term: prefix + '甥女', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
      if (tg === 'male') return { term: prefix + '甥', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
      return { term: prefix + '甥/甥女', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
    }
    if (tg === 'female') return { term: prefix + '侄女', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
    if (tg === 'male') return { term: prefix + '侄', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
    return { term: prefix + '侄/侄女', tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };
  }

  /* ---- (3,3) 再从兄弟 / 二表 ---- */
  if (a === 3 && b === 3)
    return { term: (maleLine ? '再从' : '二表') + siblingTerm(tg, sen), tag: maleLine ? '堂亲' : '表亲', placeholder: true, a, b, pathA, pathB };

  /* ---- (3,1) 祖父母的同辈 ---- */
  if (a === 3 && b === 1) {
    if (linkA && linkA.gender === 'female') {
      if (tg === 'female') return { term: '姨祖母', tag: '祖孙', placeholder: true, a, b, pathA, pathB };
      if (tg === 'male') return { term: '舅祖父', tag: '祖孙', placeholder: true, a, b, pathA, pathB };
      return { term: '舅/姨祖父', tag: '祖孙', placeholder: true, a, b, pathA, pathB };
    }
    if (tg === 'female') return { term: '姑祖母', tag: '祖孙', placeholder: true, a, b, pathA, pathB };
    if (tg === 'male') return { term: sen > 0 ? '叔祖父' : sen < 0 ? '伯祖父' : '伯/叔祖父', tag: '祖孙', placeholder: true, a, b, pathA, pathB };
    return { term: '伯/叔祖父', tag: '祖孙', placeholder: true, a, b, pathA, pathB };
  }

  /* ---- (1,3) 兄弟姐妹之孙辈 ---- */
  if (a === 1 && b === 3) {
    if (linkB && linkB.gender === 'female') {
      if (tg === 'female') return { term: '甥孙女', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
      if (tg === 'male') return { term: '甥孙', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
      return { term: '甥孙辈', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
    }
    if (tg === 'female') return { term: '侄孙女', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
    if (tg === 'male') return { term: '侄孙', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
    return { term: '侄孙辈', tag: '叔侄', placeholder: true, a, b, pathA, pathB };
  }

  /* ---- 更远：远房占位 ---- */
  let suf;
  if (a === b) suf = siblingTerm(tg, sen);
  else if (a > b) suf = tg === 'female' ? '祖母辈' : tg === 'male' ? '祖父辈' : '祖辈';
  else suf = '孙辈';
  return { term: (maleLine ? '远房堂' : '远房表') + suf, tag: '远亲', placeholder: true, a, b, pathA, pathB };
}

/** 直系口语化类型前缀：父亲→养父/继父，儿子→养子/继子… */
const TYPED_DIRECT_MAP = {
  '父亲': '父', '母亲': '母', '父/母': '父/母',
  '儿子': '子', '女儿': '女', '孩子': '子女',
  '孙子': '孙', '孙女': '孙女', '孙辈': '孙辈',
  '外孙': '外孙', '外孙女': '外孙女', '外孙辈': '外孙辈',
};

/** 对血亲基础称谓应用 养/继 类型前缀；旁系非亲生给占位称谓 */
function applyTypedPrefix(base, typed) {
  const prefix = typed.hasStep ? '继' : '养';
  const directLine = (base.a === 0 || base.b === 0);
  const siblings = (base.a === 1 && base.b === 1);
  let term;
  if (directLine && TYPED_DIRECT_MAP[base.term]) term = prefix + TYPED_DIRECT_MAP[base.term];
  else term = prefix + base.term;
  // 直系与兄弟姐妹有通行称谓；其余旁系（养叔、继表兄…）无确定传统称谓 → 占位
  const placeholder = base.placeholder || !(directLine || siblings);
  return { term, placeholder };
}

/* ---------------- 姻亲称谓 ---------------- */
/** 配偶的血亲：ego →(配偶边)→ Y →(segB)→ target */
function inLawOfSpouse(segB, spouse, target, ego) {
  const a = segB.filter(s => s.kind === 'up').length;
  const b = segB.filter(s => s.kind === 'down').length;
  const tg = target.gender;
  const eg = ego.gender;
  const sg = spouse.gender;
  const typed = typedInfo(segB);
  const nonBio = typed.hasAdopt || typed.hasStep;

  // 配偶的父母：岳父/岳母（我为男）或 公公/婆婆（我为女）
  if (a === 1 && b === 0) {
    if (nonBio) return { term: (typed.hasStep ? '继' : '养') + (tg === 'female' ? '岳母/婆婆' : '岳父/公公'), placeholder: true };
    if (eg === 'male') return { term: tg === 'female' ? '岳母' : tg === 'male' ? '岳父' : '岳父/岳母', placeholder: tg === 'unknown' };
    if (eg === 'female') return { term: tg === 'female' ? '婆婆' : tg === 'male' ? '公公' : '公公/婆婆', placeholder: tg === 'unknown' };
    return { term: tg === 'female' ? '配偶的母亲' : tg === 'male' ? '配偶的父亲' : '配偶的父母', placeholder: true };
  }
  // 配偶的祖辈
  if (a === 2 && b === 0) {
    if (eg === 'male' && !nonBio)
      return { term: tg === 'female' ? '岳祖母' : tg === 'male' ? '岳祖父' : '岳祖父母', placeholder: true };
    return { term: `配偶的${tg === 'female' ? '祖母' : tg === 'male' ? '祖父' : '祖父母'}`, placeholder: true };
  }
  // 配偶的子女（非本人所生）→ 继子女
  if (a === 0 && b === 1)
    return { term: tg === 'female' ? '继女' : tg === 'male' ? '继子' : '继子女', placeholder: tg === 'unknown' };
  // 配偶的孙辈 → 继孙辈（占位）
  if (a === 0 && b === 2)
    return { term: tg === 'female' ? '继孙女' : tg === 'male' ? '继孙' : '继孙辈', placeholder: true };
  // 配偶的兄弟姐妹
  if (a === 1 && b === 1) {
    const sen = seniority(target, spouse); // 对方相对配偶的长幼
    if (sg === 'female') { // 妻子的兄弟姐妹
      if (tg === 'male') return { term: sen > 0 ? '内兄' : sen < 0 ? '内弟' : '内兄/内弟', placeholder: sen === 0 };
      if (tg === 'female') return { term: sen > 0 ? '妻姐' : sen < 0 ? '妻妹' : '妻姐/妻妹', placeholder: sen === 0 };
      return { term: '配偶的兄弟姐妹', placeholder: true };
    }
    if (sg === 'male') { // 丈夫的兄弟姐妹
      if (tg === 'male') return { term: sen > 0 ? '夫兄' : sen < 0 ? '夫弟' : '夫兄/夫弟', placeholder: sen === 0 };
      if (tg === 'female') return { term: sen > 0 ? '夫姐' : sen < 0 ? '夫妹' : '夫姐/夫妹', placeholder: sen === 0 };
      return { term: '配偶的兄弟姐妹', placeholder: true };
    }
    return { term: `配偶的${siblingTerm(tg, sen)}`, placeholder: true };
  }
  // 其余：以“配偶的 ××”占位
  const base = baseFamilyTerm(spouse, target, segB);
  return { term: `配偶的${base.term}`, placeholder: true };
}

/** 血亲的配偶：ego →(segA)→ X →(配偶边)→ target */
function spouseOfRelative(segA, X, target, ego) {
  const a = segA.filter(s => s.kind === 'up').length;
  const b = segA.filter(s => s.kind === 'down').length;
  const tg = target.gender;
  const xg = X.gender;
  const nodes = [ego.id, ...segA.map(s => s.to)];

  // 父母的配偶（非本人父母）→ 继父/继母
  if (a === 1 && b === 0)
    return { term: tg === 'female' ? '继母' : tg === 'male' ? '继父' : '继父/母', placeholder: tg === 'unknown' };
  // 祖父母的配偶 → 继祖父/继祖母
  if (a === 2 && b === 0)
    return { term: tg === 'female' ? '继祖母' : tg === 'male' ? '继祖父' : '继祖父/母', placeholder: tg === 'unknown' };
  // 兄弟姐妹的配偶：嫂/弟媳、姐夫/妹夫
  if (a === 1 && b === 1) {
    const sen = seniority(X, ego); // X 相对我的长幼
    if (xg === 'male') return { term: sen > 0 ? '嫂嫂' : sen < 0 ? '弟媳' : '嫂/弟媳', placeholder: sen === 0 };
    if (xg === 'female') return { term: sen > 0 ? '姐夫' : sen < 0 ? '妹夫' : '姐夫/妹夫', placeholder: sen === 0 };
    return { term: '兄弟姐妹的配偶', placeholder: true };
  }
  // 子女的配偶：儿媳/女婿
  if (a === 0 && b === 1)
    return { term: xg === 'male' ? '儿媳' : xg === 'female' ? '女婿' : '子女的配偶', placeholder: xg === 'unknown' };
  // 孙辈的配偶
  if (a === 0 && b === 2) {
    const mid = byId(nodes[1]);
    const outer = mid && mid.gender === 'female' ? '外' : '';
    return { term: xg === 'male' ? outer + '孙媳' : xg === 'female' ? outer + '孙女婿' : outer + '孙辈配偶', placeholder: xg === 'unknown' };
  }
  // 叔伯姑舅姨的配偶：伯母/婶婶/姑父/舅母/姨父
  if (a === 2 && b === 1) {
    const linkA = byId(nodes[1]); // ego 的父/母
    const sen = seniority(X, linkA); // X 相对 ego 父母的长幼
    if (linkA && linkA.gender === 'male') {
      if (xg === 'male') return { term: sen > 0 ? '伯母' : sen < 0 ? '婶婶' : '伯母/婶婶', placeholder: sen === 0 };
      if (xg === 'female') return { term: '姑父', placeholder: false };
    }
    if (linkA && linkA.gender === 'female') {
      if (xg === 'male') return { term: '舅母', placeholder: false };
      if (xg === 'female') return { term: '姨父', placeholder: false };
    }
    return { term: '祖辈亲人的配偶', placeholder: true };
  }
  // 其余：以“×× 的配偶”占位
  const base = baseFamilyTerm(ego, X, segA);
  return { term: `${base.term}的配偶`, placeholder: true };
}

/* ---------------- 主入口 ---------------- */
/**
 * 推导 ego 对 target 的称谓。
 * 返回 { term, tag, relType, detail, placeholder }
 *   relType: 血缘 / 收养 / 继亲 / 收养·继亲 / 姻亲 / 无关联
 */
function kinship(egoId, targetId) {
  if (egoId === targetId) return { term: '本人', tag: '直系', relType: '血缘', detail: '', placeholder: false };
  const ego = byId(egoId), target = byId(targetId);
  if (!ego || !target) return null;

  const raw = bestPath(egoId, targetId);
  if (!raw) {
    return { term: '无亲属关联', tag: '无关联', relType: '无关联', detail: '两人物未通过父母或配偶关系连通', placeholder: true };
  }
  const steps = normalizeSteps(raw);
  const detail = '推导路径：' + renderPath(egoId, steps);
  const spouseIdx = [];
  steps.forEach((s, i) => { if (s.kind === 'spouse') spouseIdx.push(i); });

  /* ---- 纯家庭路径（无配偶边） ---- */
  if (!spouseIdx.length) {
    const typed = typedInfo(steps);
    const relType = !typed.hasAdopt && !typed.hasStep ? '血缘'
      : typed.hasAdopt && typed.hasStep ? '收养·继亲'
      : typed.hasAdopt ? '收养' : '继亲';
    const base = baseFamilyTerm(ego, target, steps);
    if (relType === '血缘') return { term: base.term, tag: base.tag, relType, detail, placeholder: !!base.placeholder };
    const t = applyTypedPrefix(base, typed);
    return { term: t.term, tag: base.tag, relType, detail, placeholder: t.placeholder };
  }

  /* ---- 姻亲路径 ---- */
  const relType = '姻亲';
  // 目标即配偶本人
  if (steps.length === 1) {
    const term = target.gender === 'male' ? '丈夫' : target.gender === 'female' ? '妻子' : '配偶';
    return { term, tag: '配偶', relType, detail, placeholder: target.gender === 'unknown' };
  }
  // 多重配偶边：无法确定传统称谓 → 占位
  if (spouseIdx.length > 1) {
    return { term: '远房姻亲', tag: '姻亲', relType, detail, placeholder: true };
  }

  const i = spouseIdx[0];
  const segA = steps.slice(0, i);            // ego → X（血亲段）
  const segB = steps.slice(i + 1);           // Y → target（血亲段）
  const X = i === 0 ? ego : byId(steps[i - 1].to);
  const Y = byId(steps[i].to);               // X 的配偶

  if (!segA.length && !segB.length) {
    const term = target.gender === 'male' ? '丈夫' : target.gender === 'female' ? '妻子' : '配偶';
    return { term, tag: '配偶', relType, detail, placeholder: target.gender === 'unknown' };
  }
  // 配偶的血亲
  if (!segA.length) {
    const r = inLawOfSpouse(segB, Y, target, ego);
    return { term: r.term, tag: '姻亲', relType, detail, placeholder: !!r.placeholder };
  }
  // 血亲的配偶
  if (!segB.length) {
    const r = spouseOfRelative(segA, X, target, ego);
    return { term: r.term, tag: '姻亲', relType, detail, placeholder: !!r.placeholder };
  }
  // 父母的配偶的子女 → 继兄弟姐妹
  const aA = segA.filter(s => s.kind === 'up').length, bA = segA.length - aA;
  const aB = segB.filter(s => s.kind === 'up').length, bB = segB.length - aB;
  if (aA === 1 && bA === 0 && aB === 0 && bB === 1) {
    const sen = seniority(target, ego);
    return { term: '继' + siblingTerm(target.gender, sen), tag: '姻亲', relType, detail, placeholder: target.gender === 'unknown' };
  }
  // 其余复合姻亲：占位
  const tA = baseFamilyTerm(ego, X, segA).term;
  const tB = baseFamilyTerm(Y, target, segB).term;
  return { term: `${tA}的配偶的${tB}`, tag: '姻亲', relType, detail, placeholder: true };
}

/** 称谓（含用户手工修正） */
function displayKinship(egoId, targetId) {
  const k = kinship(egoId, targetId);
  if (!k) return null;
  const key = egoId + '>>' + targetId;
  const custom = state.customTerms[key];
  if (custom && custom.term) return { ...k, term: custom.term, custom: true, customNote: custom.note || '' };
  return k;
}

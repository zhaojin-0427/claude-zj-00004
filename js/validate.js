/* =====================================================================
 * validate.js —— 关系冲突校验
 *
 * 阻断级（block，禁止保存/导入）：
 *   self-parent   自我引用：自己是自己的父母
 *   self-spouse   自我引用：自己是自己的配偶
 *   dup-parent    重复父母：同一人被重复登记（包括既为父又为母）
 *   slot-conflict 同一槽位冲突：同一「角色×类型」槽位被多人占用
 *   cycle         祖先循环：沿父母链上溯回到自己
 *   dangling      引用了不存在的人物
 * 提示级（warn，确认后可继续）：
 *   role-gender   槽位角色与对方性别不符（父亲为女 / 母亲为男）
 *   gen-parent    明显辈分矛盾：子女辈分未晚于父母
 *   gen-spouse    明显辈分矛盾：配偶辈分相差 2 辈及以上
 *
 * validateAll(people) → [{ level, type, msg, personIds }]
 * ===================================================================== */
'use strict';

const ISSUE_TYPE_LABEL = {
  'self-parent': '自我引用',
  'self-spouse': '自我引用',
  'dup-parent': '重复父母',
  'slot-conflict': '槽位冲突',
  'cycle': '祖先循环',
  'dangling': '悬空引用',
  'role-gender': '角色性别不符',
  'gen-parent': '辈分矛盾',
  'gen-spouse': '辈分矛盾',
};

function validateAll(people) {
  const issues = [];
  const map = new Map(people.map(p => [p.id, p]));
  const nm = p => (p && p.name) || '未命名';
  const push = (level, type, msg, personIds) =>
    issues.push({ level, type, msg, personIds: [...new Set(personIds)] });

  /* ---- 逐人物检查 ---- */
  for (const p of people) {
    const parents = p.parents || [];
    const spouses = p.spouses || [];

    // 自我引用
    if (parents.some(e => e.id === p.id))
      push('block', 'self-parent', `「${nm(p)}」的父母记录中包含自己（自我引用）。`, [p.id]);
    if (spouses.includes(p.id))
      push('block', 'self-spouse', `「${nm(p)}」的配偶中包含自己（自我引用）。`, [p.id]);

    // 重复父母：同一人出现多次（含既登记为父又登记为母）
    const seenPar = new Map();
    for (const e of parents) {
      if (seenPar.has(e.id)) {
        const other = map.get(e.id);
        push('block', 'dup-parent',
          `「${nm(map.get(e.id)) || e.id}」被重复登记为「${nm(p)}」的父母（${seenPar.get(e.id)} / ${roleLabel(e.role)}·${relTypeLabel(e.type)}）。`,
          [p.id, e.id]);
      } else {
        seenPar.set(e.id, `${roleLabel(e.role)}·${relTypeLabel(e.type)}`);
      }
    }

    // 同一槽位冲突：角色×类型 唯一
    const slot = new Map();
    for (const e of parents) {
      const key = e.role + ':' + e.type;
      const label = `${roleLabel(e.role)}·${relTypeLabel(e.type)}`;
      if (slot.has(key) && slot.get(key) !== e.id) {
        push('block', 'slot-conflict',
          `「${nm(p)}」的「${label}」槽位被「${nm(map.get(slot.get(key)))}」与「${nm(map.get(e.id))}」同时占用。`,
          [p.id, slot.get(key), e.id]);
      } else if (!slot.has(key)) {
        slot.set(key, e.id);
      }
    }

    // 悬空引用
    for (const e of parents) {
      if (!map.has(e.id))
        push('block', 'dangling', `「${nm(p)}」的${roleLabel(e.role)}（${relTypeLabel(e.type)}）引用了不存在的人物。`, [p.id]);
    }
    for (const s of spouses) {
      if (!map.has(s))
        push('block', 'dangling', `「${nm(p)}」的配偶引用了不存在的人物。`, [p.id]);
    }

    // 角色与性别不符（提示级）
    for (const e of parents) {
      const par = map.get(e.id);
      if (!par) continue;
      if (e.role === 'father' && par.gender === 'female')
        push('warn', 'role-gender', `「${nm(par)}」性别为女，却被登记为「${nm(p)}」的父亲（${relTypeLabel(e.type)}）。`, [p.id, e.id]);
      if (e.role === 'mother' && par.gender === 'male')
        push('warn', 'role-gender', `「${nm(par)}」性别为男，却被登记为「${nm(p)}」的母亲（${relTypeLabel(e.type)}）。`, [p.id, e.id]);
    }

    // 辈分矛盾：子女应晚于父母一辈以上（提示级）
    for (const e of parents) {
      const par = map.get(e.id);
      if (!par) continue;
      if (Number.isFinite(p.gen) && Number.isFinite(par.gen) && p.gen <= par.gen)
        push('warn', 'gen-parent',
          `「${nm(p)}」（第${p.gen}辈）的辈分未晚于其${roleLabel(e.role)}「${nm(par)}」（第${par.gen}辈）。`,
          [p.id, e.id]);
    }
  }

  /* ---- 配偶辈分差距（提示级，去重） ---- */
  const pairSeen = new Set();
  for (const p of people) {
    for (const s of (p.spouses || [])) {
      const key = [p.id, s].sort().join('~');
      if (pairSeen.has(key)) continue;
      pairSeen.add(key);
      const sp = map.get(s);
      if (!sp) continue;
      if (Number.isFinite(p.gen) && Number.isFinite(sp.gen) && Math.abs(p.gen - sp.gen) >= 2)
        push('warn', 'gen-spouse',
          `配偶「${nm(p)}」（第${p.gen}辈）与「${nm(sp)}」（第${sp.gen}辈）辈分相差 ${Math.abs(p.gen - sp.gen)} 辈。`,
          [p.id, s]);
    }
  }

  /* ---- 祖先循环（阻断级，沿父母边 DFS） ---- */
  const color = new Map(); // 1=在栈中 2=已完成
  const stack = [];
  const cycleSeen = new Set();
  const dfs = (u) => {
    color.set(u, 1);
    stack.push(u);
    const p = map.get(u);
    for (const e of (p.parents || [])) {
      if (!map.has(e.id)) continue;
      const c = color.get(e.id);
      if (c === 1) {
        const cyc = stack.slice(stack.indexOf(e.id));
        const key = [...cyc].sort().join('|');
        if (!cycleSeen.has(key)) {
          cycleSeen.add(key);
          const names = [...cyc, e.id].map(id => nm(map.get(id))).join(' → ');
          push('block', 'cycle', `祖先循环：${names}（沿父母链上溯回到自己）。`, cyc);
        }
      } else if (!c) {
        dfs(e.id);
      }
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const p of people) if (!color.get(p.id)) dfs(p.id);

  // 阻断级在前，提示级在后
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'block' ? -1 : 1));
}

/** 当前全局状态的校验结果（带缓存，状态变更后需调用 invalidateIssues） */
let _issueCache = null;
function currentIssues() {
  if (!_issueCache) _issueCache = validateAll(state.people);
  return _issueCache;
}
function invalidateIssues() { _issueCache = null; }

/** 是否包含阻断级问题 */
const hasBlock = issues => issues.some(i => i.level === 'block');

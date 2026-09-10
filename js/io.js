/* =====================================================================
 * io.js —— 导出 / 导入 JSON（含导入校验）、PNG 导出、示例数据
 * ===================================================================== */
'use strict';

/* ---------------- JSON 导出 ---------------- */
function exportJSON() {
  const data = {
    app: 'family-kin-board',
    version: STORAGE_VERSION,
    exportedAt: new Date().toISOString(),
    people: state.people,
    customTerms: state.customTerms,
    collapsed: state.collapsed,
    egoId: state.egoId,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `家谱数据_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('JSON 已导出');
}

/* ---------------- JSON 导入（先校验，阻断级拒绝导入） ---------------- */
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const d = JSON.parse(reader.result);
      if (!Array.isArray(d.people)) throw new Error('格式不正确：缺少 people');

      // 1) 规范化 + 旧格式迁移
      const raw = d.people.map(p => migratePerson({ ...p }));

      // 2) 重复/缺失 id 重映射（引用指向首个同 id 人物）
      const usedIds = new Set();
      const refMap = new Map();
      for (const p of raw) {
        const oldId = p.id;
        let newId = oldId;
        if (!newId || usedIds.has(newId)) newId = uid();
        usedIds.add(newId);
        if (oldId && !refMap.has(oldId)) refMap.set(oldId, newId);
        p.id = newId;
      }
      for (const p of raw) {
        p.parents.forEach(e => { if (refMap.has(e.id)) e.id = refMap.get(e.id); });
        p.spouses = p.spouses.map(s => refMap.get(s) ?? s);
      }
      const remapId = id => (id && refMap.has(id)) ? refMap.get(id) : id;

      // 3) 清理悬空引用、配偶对称化
      const candidate = normalizePeople(raw);

      // 4) 校验：阻断级拒绝导入；提示级确认后继续
      const issues = validateAll(candidate);
      const blocks = issues.filter(i => i.level === 'block');
      const warns = issues.filter(i => i.level === 'warn');
      if (blocks.length) {
        await showIssuesModal('导入被阻止：存在阻断级问题', blocks, {
          hideCancel: true, okText: '知道了',
          intro: `该 JSON 含 ${blocks.length} 处阻断级问题（自我引用 / 祖先循环 / 重复父母 / 槽位冲突等），请修正数据后重新导入。`,
        });
        return;
      }
      if (warns.length) {
        const ok = await showIssuesModal(`导入数据存在 ${warns.length} 处提示级问题`, warns, {
          okText: '仍然导入',
          intro: '以下问题不会阻止导入，导入后可在「校验」标签页中查看并定位：',
        });
        if (!ok) return;
      }

      // 5) 应用
      state.people = candidate;
      state.customTerms = {};
      for (const [key, val] of Object.entries(d.customTerms || {})) {
        const [a, b] = key.split('>>');
        const ra = remapId(a), rb = remapId(b);
        if (byId(ra) && byId(rb)) state.customTerms[ra + '>>' + rb] = val;
      }
      state.collapsed = d.collapsed || {};
      state.egoId = byId(remapId(d.egoId)) ? remapId(d.egoId) : null;
      state.genFilter = 'all';
      state.draft = null;
      state.selectedId = null;
      save(); renderGenFilter(); renderAll(); fitView();
      toast(`导入成功：${state.people.length} 位人物` + (warns.length ? `（${warns.length} 处提示级问题，见「校验」页）` : ''));
    } catch (e) {
      toast('导入失败：' + e.message);
    }
  };
  reader.readAsText(file);
}

/* ---------------- PNG：Canvas 手工绘制当前视图 ---------------- */
async function exportPNG() {
  const hiddenSet = hiddenByCollapse();
  const vis = state.people.filter(p => isVisible(p, hiddenSet));
  if (!vis.length) { toast('没有可导出的人物'); return; }
  toast('正在生成 PNG…');
  const visIds = new Set(vis.map(p => p.id));

  const pad = 70;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of vis) {
    minX = Math.min(minX, p.x ?? 0); minY = Math.min(minY, p.y ?? 0);
    maxX = Math.max(maxX, (p.x ?? 0) + NODE_W); maxY = Math.max(maxY, (p.y ?? 0) + NODE_H);
  }
  const W = (maxX - minX) + pad * 2;
  const H = (maxY - minY) + pad * 2 + 44; // 顶部标题空间
  const scale = 2;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // 背景
  ctx.fillStyle = '#f4f6fa';
  ctx.fillRect(0, 0, W, H);

  // 标题
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 16px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText(`家族关系图${state.egoId ? `（称谓基准：${byId(state.egoId)?.name || ''}）` : ''}`, pad, 30);
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px sans-serif';
  ctx.fillText(new Date().toLocaleString('zh-CN') + ` · 共 ${vis.length} 人`, pad, 48);

  const ox = pad - minX, oy = pad + 44 - minY;

  // 亲子边：亲生实线 / 收养继亲虚线
  const drawn = new Set();
  for (const p of vis) {
    for (const e of (p.parents || [])) {
      const parent = byId(e.id);
      if (!parent || !visIds.has(parent.id)) continue;
      const key = e.id + '->' + p.id + ':' + e.type;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const st = edgeStyleOf(e.type);
      const x1 = (parent.x ?? 0) + NODE_W / 2 + ox;
      const y1 = (parent.y ?? 0) + NODE_H - 6 + oy;
      const x2 = (p.x ?? 0) + NODE_W / 2 + ox;
      const y2 = (p.y ?? 0) + 8 + oy;
      const my = (y1 + y2) / 2;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.setLineDash(st.dash ? st.dash.split(' ').map(Number) : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, my, x2, my, x2, y2);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // 配偶点线
  const coupleDrawn = new Set();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = EDGE_STYLE.spouse.color;
  ctx.lineWidth = EDGE_STYLE.spouse.width;
  for (const p of vis) {
    for (const { person: sp } of allPartnersOf(p.id)) {
      if (!visIds.has(sp.id)) continue;
      const key = [p.id, sp.id].sort().join('~');
      if (coupleDrawn.has(key)) continue;
      coupleDrawn.add(key);
      const x1 = (p.x ?? 0) + NODE_W + ox, y1 = (p.y ?? 0) + NODE_H / 2 + oy;
      const x2 = (sp.x ?? 0) + ox, y2 = (sp.y ?? 0) + NODE_H / 2 + oy;
      ctx.beginPath();
      ctx.moveTo(Math.min(x1, x2), y1);
      ctx.lineTo(Math.max(x1, x2), y2);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // 节点
  const roundRect = (c, x, y, w, h, r) => {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  };
  for (const p of vis) {
    const x = (p.x ?? 0) + ox, y = (p.y ?? 0) + oy;
    // 卡片
    ctx.shadowColor = 'rgba(31,41,55,.12)';
    ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, y, NODE_W, NODE_H, 10); ctx.fill();
    ctx.shadowColor = 'transparent';
    // 顶条
    const topColor = p.gender === 'male' ? '#2563eb' : p.gender === 'female' ? '#db2777' : '#6b7280';
    ctx.fillStyle = topColor;
    roundRect(ctx, x, y, NODE_W, NODE_H, 10); ctx.save(); ctx.clip();
    ctx.fillRect(x, y, NODE_W, 3);
    ctx.restore();
    ctx.strokeStyle = state.egoId === p.id ? '#059669' : '#e5e7eb';
    ctx.lineWidth = state.egoId === p.id ? 2 : 1;
    roundRect(ctx, x, y, NODE_W, NODE_H, 10); ctx.stroke();

    // 圆点
    ctx.fillStyle = topColor;
    ctx.beginPath(); ctx.arc(x + 13, y + 20, 4, 0, Math.PI * 2); ctx.fill();
    // 姓名
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 13px "PingFang SC","Microsoft YaHei",sans-serif';
    let nm = p.name || '未命名';
    if (ctx.measureText(nm).width > 84) {
      while (nm.length > 1 && ctx.measureText(nm + '…').width > 84) nm = nm.slice(0, -1);
      nm += '…';
    }
    ctx.fillText(nm, x + 22, y + 24);
    if (state.egoId === p.id) {
      ctx.fillStyle = '#059669';
      roundRect(ctx, x + 22 + ctx.measureText(nm).width + 5, y + 12, 18, 13, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif';
      ctx.fillText('我', x + 22 + ctx.measureText(nm).width + 10, y + 22);
    }
    // 元信息
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText(`第${p.gen ?? 0}辈${p.order >= 1 ? '·排行' + p.order : ''}`, x + 12, y + 42);
    // 称谓
    if (state.egoId && state.egoId !== p.id) {
      const k = displayKinship(state.egoId, p.id);
      if (k && k.tag !== '无关联') {
        ctx.font = 'bold 11px "PingFang SC","Microsoft YaHei",sans-serif';
        const tw = Math.min(108, ctx.measureText(k.term).width + 14);
        ctx.fillStyle = k.custom ? '#fce7f3' : '#dbeafe';
        roundRect(ctx, x + 10, y + 50, tw, 19, 5); ctx.fill();
        ctx.fillStyle = k.custom ? '#be185d' : '#1d4ed8';
        ctx.fillText(k.term, x + 17, y + 63);
      }
    }
    // 折叠计数
    const hc = state.collapsed[p.id] ? branchMembers(p.id).length - 1 : 0;
    if (hc > 0) {
      ctx.fillStyle = '#4b5563';
      ctx.beginPath(); ctx.arc(x + NODE_W - 8, y - 6, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(hc, x + NODE_W - 8, y - 2); ctx.textAlign = 'left';
    }
  }

  // 图例：性别 + 称谓基准 + 三种关系线型
  ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
  let lx = pad;
  const ly = H - 26;
  ctx.fillStyle = '#6b7280';
  ctx.fillText('图例：', lx, ly);
  lx += 40;
  for (const [c, t] of [['#2563eb', '男'], ['#db2777', '女'], ['#059669', '称谓基准']]) {
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(lx, ly - 4, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b7280'; ctx.fillText(t, lx + 7, ly);
    lx += 14 + ctx.measureText(t).width + 12;
  }
  const lineLegends = [
    [EDGE_STYLE.bio, '亲生'],
    [EDGE_STYLE.nonbio, '收养/继亲'],
    [EDGE_STYLE.spouse, '配偶'],
  ];
  for (const [st, t] of lineLegends) {
    ctx.strokeStyle = st.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(st.dash ? st.dash.split(' ').map(Number) : []);
    ctx.beginPath(); ctx.moveTo(lx, ly - 4); ctx.lineTo(lx + 26, ly - 4); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#6b7280'; ctx.fillText(t, lx + 31, ly);
    lx += 31 + ctx.measureText(t).width + 14;
  }

  try {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `家族关系图_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    toast('PNG 已导出');
  } catch (e) { toast('PNG 导出失败：' + e.message); }
}

/* =====================================================================
 * 示例数据：涵盖亲生 / 收养 / 继亲 / 显式配偶 / 姻亲
 * ===================================================================== */
function buildSample() {
  const P = (id, role, type = 'bio') => ({ id, role, type });
  const mk = (name, gen, gender, order, parents = []) => migratePerson({
    id: uid(), name, gen, gender, order, parents, spouses: [], note: '', x: 0, y: 0,
  });
  const marry = (a, b) => { a.spouses.push(b.id); b.spouses.push(a.id); };

  const g1 = mk('李守仁', 1, 'male', 1);
  const g1w = mk('王秀兰', 1, 'female', 1);
  const g2a = mk('李建国', 2, 'male', 1, [P(g1.id, 'father'), P(g1w.id, 'mother')]);
  const g2b = mk('李建华', 2, 'male', 2, [P(g1.id, 'father'), P(g1w.id, 'mother')]);
  const g2c = mk('李建梅', 2, 'female', 3, [P(g1.id, 'father'), P(g1w.id, 'mother')]);
  const g2w = mk('赵淑芬', 2, 'female', 1);
  const g2w2 = mk('张兰', 2, 'female', 2);
  const g3a = mk('李文', 3, 'male', 1, [P(g2a.id, 'father'), P(g2w.id, 'mother')]);
  const g3b = mk('李武', 3, 'male', 1, [P(g2b.id, 'father')]);
  const g3c = mk('赵磊', 3, 'male', 1, [P(g2c.id, 'mother')]);
  // 收养：李建国与赵淑芬的养女
  const g3d = mk('李念', 3, 'female', 2, [P(g2a.id, 'father', 'adopt'), P(g2w.id, 'mother', 'adopt')]);
  const g4 = mk('李思齐', 4, 'male', 1, [P(g3a.id, 'father')]);
  // 李文的妻子（显式配偶，无共同子女）及其父母 → 姻亲演算
  const g3w = mk('孙晓', 3, 'female', 1);
  const g2f = mk('孙伯涛', 2, 'male', 1);
  const g2m = mk('周桂香', 2, 'female', 1);
  g3w.parents = [P(g2f.id, 'father'), P(g2m.id, 'mother')];
  // 继亲：张兰之子刘洋，李建华是其继父
  const g3e = mk('刘洋', 3, 'male', 2, [P(g2w2.id, 'mother'), P(g2b.id, 'father', 'step')]);

  marry(g1, g1w);
  marry(g2a, g2w);
  marry(g2b, g2w2);
  marry(g3a, g3w);
  marry(g2f, g2m);

  return [g1, g1w, g2a, g2b, g2c, g2w, g2w2, g3a, g3b, g3c, g3d, g4, g3w, g2f, g2m, g3e];
}

async function loadSample(force) {
  if (state.people.length && !force) {
    const ok = await confirmModal('载入示例', '载入示例将覆盖当前画布上的全部数据，确定继续吗？');
    if (!ok) return;
  }
  state.people = buildSample();
  state.customTerms = {};
  state.collapsed = {};
  state.draft = null;
  state.selectedId = null;
  state.egoId = state.people.find(p => p.name === '李文')?.id || null;
  state.genFilter = 'all';
  autoLayout();
  save();
  renderGenFilter();
  renderAll();
  toast('示例已载入：双击节点可更换称谓基准');
}

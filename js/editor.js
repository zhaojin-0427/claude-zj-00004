/* =====================================================================
 * editor.js —— 人物编辑表单（基本信息 + 亲子关系槽位 + 配偶关系）
 * 保存流程：先构建候选数据 → 校验（阻断级禁止保存，提示级确认后继续）→ 应用
 * ===================================================================== */
'use strict';

/** 表单工作副本：编辑期间暂存关系改动，保存时才写回 */
let formWork = null; // { parents: [{id, role, type}], spouses: [id] }

function openEditor(id) {
  discardDraft();
  revealNode(id);
  state.tab = 'people';
  state.selectedId = id;
  renderAll();
  const p = byId(id);
  if (p) renderEditorForm(p, false);
}

function renderEditorForm(p, isDraft) {
  if (!isDraft && !byId(p.id)) { renderPeopleTab(); return; }
  formWork = {
    parents: deepCopy(p.parents || []),
    spouses: [...(p.spouses || [])],
  };
  const forbidden = isDraft ? new Set() : descendantSet(p.id); // 后代不能被选为父母（防环）

  sideBody.innerHTML = `
    <div class="section-title">
      <span class="mini-link" id="backList">← 返回列表</span>
      <span>${isDraft ? '新建人物' : '编辑人物'}</span>
    </div>
    ${isDraft ? '<div class="gen-warn" style="display:block;background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8">填写后点击「保存」才会加入家谱；返回列表将放弃本次新建。</div>' : ''}
    <div class="gen-warn" id="genWarn">⚠ 父母辈分不一致或与本人辈分冲突，请检查。</div>
    <div class="field">
      <label>姓名</label>
      <input type="text" id="fName" value="${esc(p.name)}" placeholder="人物姓名" autofocus>
    </div>
    <div class="field">
      <label>性别</label>
      <div class="seg" id="fGender">
        ${GENDER.map(g => `<div class="opt ${p.gender === g.v ? 'on' : ''}" data-v="${g.v}">${g.label}</div>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>辈分（数字，越大越晚辈；用于分层与筛选）</label>
      <input type="number" id="fGen" value="${p.gen ?? 0}">
    </div>
    <div class="field">
      <label>出生顺序（同辈排行，1 为长）</label>
      <input type="number" id="fOrder" value="${p.order ?? ''}" min="1" placeholder="如 1、2、3">
    </div>
    <div class="rel-block">
      <div class="rb-title">父母（亲子关系）<span style="font-weight:400;color:var(--ink-3)">每「角色×类型」槽位唯一</span></div>
      <div id="parentRows"></div>
      <button class="rel-add" id="addParentRow">＋ 添加父母记录</button>
    </div>
    <div class="rel-block">
      <div class="rb-title">配偶关系</div>
      <div id="spouseRows"></div>
      <div class="spouse-add-row">
        <select id="spouseSelect"></select>
        <button class="btn" id="addSpouseBtn">＋ 建立</button>
      </div>
    </div>
    <div class="field">
      <label>人物备注</label>
      <textarea id="fNote" placeholder="生卒、字、籍贯、过继等说明">${esc(p.note || '')}</textarea>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="fSave">${isDraft ? '保存人物' : '保存'}</button>
      <button class="btn ${isDraft ? '' : 'danger'}" id="fDelete">${isDraft ? '取消新建' : '删除'}</button>
    </div>
  `;
  sideBody.querySelector('#fName').focus();

  let gender = p.gender;
  sideBody.querySelectorAll('#fGender .opt').forEach(o => o.addEventListener('click', () => {
    gender = o.dataset.v;
    sideBody.querySelectorAll('#fGender .opt').forEach(x => x.classList.toggle('on', x === o));
  }));

  /* ---------- 父母记录行 ---------- */
  const parentRowsEl = () => sideBody.querySelector('#parentRows');
  const personOptions = (role, cur) => {
    const want = role === 'father' ? 'male' : 'female';
    return state.people
      .filter(x => x.id !== p.id && !forbidden.has(x.id)
        && (x.gender === want || x.gender === 'unknown' || x.id === cur))
      .map(x => `<option value="${x.id}" ${cur === x.id ? 'selected' : ''}>${esc(x.name || '未命名')}（${genderLabel(x.gender)} · 第${x.gen ?? 0}辈）</option>`).join('');
  };
  const renderParentRows = () => {
    parentRowsEl().innerHTML = formWork.parents.map((e, i) => `
      <div class="rel-row" data-i="${i}">
        <select class="pr-role">${PARENT_ROLES.map(r => `<option value="${r.v}" ${e.role === r.v ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
        <select class="pr-type">${REL_TYPES.map(t => `<option value="${t.v}" ${e.type === t.v ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        <select class="pr-person"><option value="">— 未录入 —</option>${personOptions(e.role, e.id)}</select>
        <button class="pr-del" title="移除该记录">✕</button>
      </div>`).join('');
    parentRowsEl().querySelectorAll('.rel-row').forEach(row => {
      const i = +row.dataset.i;
      row.querySelector('.pr-role').addEventListener('change', ev => {
        formWork.parents[i].role = ev.target.value;
        renderParentRows();   // 角色变化后重建人选列表（按性别过滤）
        suggestGen();
      });
      row.querySelector('.pr-type').addEventListener('change', ev => {
        formWork.parents[i].type = ev.target.value;
      });
      row.querySelector('.pr-person').addEventListener('change', ev => {
        formWork.parents[i].id = ev.target.value || null;
        suggestGen();
      });
      row.querySelector('.pr-del').addEventListener('click', () => {
        formWork.parents.splice(i, 1);
        renderParentRows();
        suggestGen();
      });
    });
  };
  sideBody.querySelector('#addParentRow').addEventListener('click', () => {
    // 优先占用尚未使用的「角色×类型」槽位
    const used = new Set(formWork.parents.map(e => e.role + ':' + e.type));
    const slot = PARENT_ROLES
      .flatMap(r => REL_TYPES.map(t => ({ role: r.v, type: t.v })))
      .find(s => !used.has(s.role + ':' + s.type));
    if (!slot) { toast('最多 6 条父母记录（2 角色 × 3 类型）'); return; }
    formWork.parents.push({ id: null, role: slot.role, type: slot.type });
    renderParentRows();
  });

  /* ---------- 配偶行 ---------- */
  const spouseRowsEl = () => sideBody.querySelector('#spouseRows');
  const renderSpouseRows = () => {
    const explicit = formWork.spouses.map(id => byId(id)).filter(Boolean);
    // 共同子女推定的伴侣（只读展示，解除需修改子女的父母记录）
    const inferred = isDraft ? [] : coParentPartnersOf(p.id).filter(cp => !formWork.spouses.includes(cp.person.id));
    spouseRowsEl().innerHTML =
      explicit.map(sp => `
        <div class="spouse-row" data-id="${sp.id}">
          <span class="dot ${sp.gender}" style="width:8px;height:8px"></span>
          <span class="sp-name">${esc(sp.name || '未命名')}</span>
          <span class="sp-tag">配偶</span>
          <button class="sp-del" title="解除配偶关系">✕</button>
        </div>`).join('') +
      inferred.map(cp => `
        <div class="spouse-row">
          <span class="dot ${cp.person.gender}" style="width:8px;height:8px"></span>
          <span class="sp-name">${esc(cp.person.name || '未命名')}</span>
          <span class="sp-tag inferred">因共同子女「${esc(cp.child.name || '未命名')}」关联</span>
        </div>`).join('') +
      (!explicit.length && !inferred.length ? '<div style="color:var(--ink-3);font-size:11px;padding:2px 0 6px">暂无配偶记录。</div>' : '');
    spouseRowsEl().querySelectorAll('.spouse-row[data-id]').forEach(row => {
      row.querySelector('.sp-del').addEventListener('click', () => {
        formWork.spouses = formWork.spouses.filter(s => s !== row.dataset.id);
        renderSpouseRows();
        renderSpouseSelect();
      });
    });
  };
  const renderSpouseSelect = () => {
    const sel = sideBody.querySelector('#spouseSelect');
    sel.innerHTML = '<option value="">— 选择人物建立配偶关系 —</option>' + state.people
      .filter(x => x.id !== p.id && !formWork.spouses.includes(x.id))
      .map(x => `<option value="${x.id}">${esc(x.name || '未命名')}（${genderLabel(x.gender)} · 第${x.gen ?? 0}辈）</option>`).join('');
  };
  sideBody.querySelector('#addSpouseBtn').addEventListener('click', () => {
    const v = sideBody.querySelector('#spouseSelect').value;
    if (!v) { toast('请先选择要结为配偶的人物'); return; }
    formWork.spouses.push(v);
    renderSpouseRows();
    renderSpouseSelect();
  });

  renderParentRows();
  renderSpouseRows();
  renderSpouseSelect();

  /* ---------- 辈分建议 ---------- */
  const suggestGen = () => {
    const gs = formWork.parents.map(e => e.id ? byId(e.id)?.gen : null).filter(g => typeof g === 'number');
    const warnEl = sideBody.querySelector('#genWarn');
    if (gs.length >= 2 && Math.min(...gs) !== Math.max(...gs)) {
      warnEl.textContent = `⚠ 父母辈分不一致（${gs.map(g => '第' + g + '辈').join(' / ')}），请检查。`;
      warnEl.style.display = 'block';
    } else if (gs.length) {
      const cur = parseInt(sideBody.querySelector('#fGen').value, 10);
      const sug = Math.max(...gs) + 1;
      if (isDraft || isNaN(cur) || cur <= Math.max(...gs)) {
        sideBody.querySelector('#fGen').value = sug;
      }
      if (!isDraft) warnEl.style.display = 'none';
    } else if (!isDraft) warnEl.style.display = 'none';
  };

  sideBody.querySelector('#backList').addEventListener('click', () => {
    if (isDraft) discardDraft();
    state.selectedId = null; renderAll();
  });

  /* ---------- 保存 ---------- */
  sideBody.querySelector('#fSave').addEventListener('click', async () => {
    const name = sideBody.querySelector('#fName').value.trim();
    const gR = strictInt(sideBody.querySelector('#fGen').value);
    const oRaw = sideBody.querySelector('#fOrder').value.trim();
    if (!name) { toast('请填写姓名'); return; }
    if (!gR.ok || gR.value < 0) { toast('辈分必须为不小于 0 的整数（不能填小数）'); return; }
    let order = null;
    if (oRaw !== '') {
      const o = strictInt(oRaw);
      if (!o.ok) { toast('出生顺序必须为整数（不能填 1.5 这样的小数），或留空'); return; }
      if (o.value < 1) { toast('出生顺序需为不小于 1 的正整数（或留空表示不排行）'); return; }
      order = o.value;
    }
    const parents = formWork.parents.filter(e => e.id).map(e => ({ id: e.id, role: e.role, type: e.type }));
    const spouses = [...formWork.spouses];
    const note = sideBody.querySelector('#fNote').value.trim();

    /* ---- 在候选数据上应用变更并校验 ---- */
    const candidate = deepCopy(state.people);
    let cp = candidate.find(x => x.id === p.id);
    if (!cp) {
      cp = { id: p.id, x: p.x ?? 40, y: p.y ?? 40 };
      candidate.push(cp);
    }
    Object.assign(cp, { name, gender, gen: gR.value, order, note, parents, spouses });

    // 配偶关系双向同步（候选数据上）
    const oldSpouses = isDraft ? [] : (byId(p.id).spouses || []);
    const affected = new Set([p.id, ...oldSpouses, ...spouses]);
    for (const s of oldSpouses) {
      if (!spouses.includes(s)) {
        const sp = candidate.find(x => x.id === s);
        if (sp) sp.spouses = sp.spouses.filter(x => x !== p.id);
      }
    }
    for (const s of spouses) {
      const sp = candidate.find(x => x.id === s);
      if (sp && !sp.spouses.includes(p.id)) sp.spouses.push(p.id);
    }

    // 性别变更：迁移其在他人父母槽位中的角色（候选数据上）
    let migrationNote = '';
    if (!isDraft && gender !== p.gender) {
      const plan = planGenderMigration(candidate, cp, gender);
      if (plan.blocks.length) {
        const detail = plan.blocks.map(b => `子女「${b.child.name || '未命名'}」的${gender === 'female' ? '母亲' : '父亲'}·${relTypeLabel(b.entry.type)}槽已被「${b.other?.name || '未命名'}」占用`).join('；');
        const ok = await confirmModal('性别与父母关系冲突',
          `将「${name}」改为${gender === 'female' ? '女' : gender === 'male' ? '男' : '未知'}后，${detail}。继续保存将解除 TA 在这些子女中的父/母关联（子女不会删除，可之后重新指定）。是否继续？`);
        if (!ok) return;
        for (const b of plan.blocks) {
          b.child.parents = b.child.parents.filter(e => !(e.id === p.id && e.role === b.entry.role && e.type === b.entry.type));
        }
        migrationNote = '，部分子女的原父/母关联已解除';
      }
      for (const m of plan.moves) m.entry.role = m.to;
      plan.blocks.forEach(b => affected.add(b.child.id));
      plan.moves.forEach(m => affected.add(m.child.id));
    }

    // 校验：阻断级禁止保存；提示级确认后继续
    const issues = validateAll(candidate).filter(i => i.personIds.some(id => affected.has(id)));
    const blocks = issues.filter(i => i.level === 'block');
    const warns = issues.filter(i => i.level === 'warn');
    if (blocks.length) {
      await showIssuesModal('存在阻断级问题，无法保存', blocks, { hideCancel: true, okText: '知道了' });
      return;
    }
    if (warns.length) {
      const ok = await showIssuesModal('发现提示级问题', warns, { okText: '仍然保存', intro: '以下问题不会阻止保存，确认无误后继续吗？' });
      if (!ok) return;
    }

    /* ---- 应用候选数据 ---- */
    state.people = candidate;
    if (isDraft) {
      state.draft = null;
      state.selectedId = p.id;
    }
    save();
    renderGenFilter();
    renderAll();
    toast((isDraft ? '人物已添加' : '已保存') + migrationNote);
  });

  /* ---------- 删除 ---------- */
  sideBody.querySelector('#fDelete').addEventListener('click', async () => {
    if (isDraft) {
      discardDraft();
      state.selectedId = null;
      renderAll();
      toast('已放弃新建');
      return;
    }
    const kids = childrenOf(p.id);
    const ok = await confirmModal('删除人物',
      `确定删除「${p.name || '未命名'}」吗？${kids.length ? `其 ${kids.length} 个子女将变为无父/无母（不会被删除）。` : '此操作不可撤销。'}`);
    if (!ok) return;
    deletePerson(p.id);
  });
}

/**
 * 性别变更时，迁移其在他人父母槽位中的角色。
 * 返回 { moves: [{entry, child, to}], blocks: [{entry, child, other}] }
 */
function planGenderMigration(people, p, newGender) {
  const moves = [], blocks = [];
  if (newGender !== 'female' && newGender !== 'male') return { moves, blocks };
  const fromRole = newGender === 'female' ? 'father' : 'mother';
  const toRole = newGender === 'female' ? 'mother' : 'father';
  for (const c of people) {
    if (c.id === p.id) continue;
    for (const e of (c.parents || [])) {
      if (e.id !== p.id || e.role !== fromRole) continue;
      const occupied = (c.parents || []).find(x => x.role === toRole && x.type === e.type && x.id !== p.id);
      if (!occupied) moves.push({ entry: e, child: c, to: toRole });
      else blocks.push({ entry: e, child: c, other: people.find(x => x.id === occupied.id) });
    }
  }
  return { moves, blocks };
}

function deletePerson(id) {
  // 清除他人指向（父母条目与配偶）
  state.people.forEach(x => {
    x.parents = (x.parents || []).filter(e => e.id !== id);
    x.spouses = (x.spouses || []).filter(s => s !== id);
  });
  state.people = state.people.filter(x => x.id !== id);
  // 清理称谓修正
  for (const key of Object.keys(state.customTerms)) {
    const [a, b] = key.split('>>');
    if (a === id || b === id) delete state.customTerms[key];
  }
  delete state.collapsed[id];
  if (state.egoId === id) state.egoId = null;
  state.selectedId = null;
  save(); renderGenFilter(); renderAll();
  toast('人物已删除');
}

function quickAddChild(parent) {
  // 依据父母性别自动匹配父/母槽位；作为“草稿”打开，保存前不入库
  const child = {
    id: uid(), name: '', gen: (parent.gen ?? 0) + 1, gender: 'unknown',
    order: childrenOf(parent.id).length + 1,
    parents: [{
      id: parent.id,
      role: parent.gender === 'female' ? 'mother' : 'father',
      type: 'bio',
    }],
    spouses: [],
    note: '', x: (parent.x ?? 0) + 160, y: (parent.y ?? 0) + GEN_GAP,
    __draft: true,
  };
  // 若已知其伴侣，自动关联另一方家长（亲生）
  const partner = allPartnersOf(parent.id)[0];
  if (partner) {
    const role = partner.person.gender === 'female' ? 'mother' : partner.person.gender === 'male' ? 'father' : null;
    if (role && !child.parents.some(e => e.role === role && e.type === 'bio')) {
      child.parents.push({ id: partner.person.id, role, type: 'bio' });
    }
  }
  openDraft(child);
}

/* =====================================================================
 * 添加人物（空表单，草稿模式：保存时才写入数据）
 * ===================================================================== */
function addPerson() {
  const rect = canvasWrap.getBoundingClientRect();
  const k = state.view.k;
  const cx = (rect.width / 2 - state.view.x) / k - NODE_W / 2;
  const cy = (rect.height / 2 - state.view.y) / k - NODE_H / 2;
  const p = {
    id: uid(), name: '', gen: 0, gender: 'unknown', order: null,
    parents: [], spouses: [], note: '',
    x: cx + (Math.random() * 60 - 30), y: cy + (Math.random() * 60 - 30),
    __draft: true,
  };
  openDraft(p);
}

/** 打开一个尚未入库的草稿人物 */
function openDraft(draft) {
  discardDraft();
  state.draft = draft;
  state.tab = 'people';
  state.selectedId = draft.id;
  renderAll();          // 画布上以虚线样式预览草稿
  renderEditorForm(draft, true);
}
function discardDraft() {
  if (state.draft) {
    state.draft = null;
    if (state.selectedId && !byId(state.selectedId)) state.selectedId = null;
  }
}

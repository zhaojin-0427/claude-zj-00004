/* =====================================================================
 * sidebar.js —— 侧栏：人物 / 支系 / 称谓演算 / 校验
 * ===================================================================== */
'use strict';

const sideBody = document.getElementById('sideBody');

function renderSidebar() {
  document.querySelectorAll('#tabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === state.tab);
  });
  syncIssueBadge();
  if (state.tab === 'people') renderPeopleTab();
  else if (state.tab === 'branches') renderBranchesTab();
  else if (state.tab === 'kin') renderKinTab();
  else renderIssuesTab();
}

/** 校验标签页角标：阻断级红色、仅提示级黄色 */
function syncIssueBadge() {
  const badge = document.getElementById('issueBadge');
  const issues = currentIssues();
  if (!issues.length) { badge.style.display = 'none'; return; }
  badge.style.display = '';
  badge.textContent = issues.length;
  badge.classList.toggle('warn-only', !hasBlock(issues));
}

/* ---------------- 人物 ---------------- */
function renderPeopleTab() {
  const sorted = [...state.people].sort((a, b) =>
    (a.gen ?? 0) - (b.gen ?? 0) || (a.order ?? 0) - (b.order ?? 0) || (a.name > b.name ? 1 : -1));
  let rows = sorted.map(p => {
    const parNames = parentEntriesOf(p).map(e => `${e.person.name || '?'}（${relTypeLabel(e.type)}）`).join(' / ');
    const spNames = allPartnersOf(p.id).map(x => x.person.name || '?').join(' / ');
    return `<div class="person-row${state.selectedId === p.id ? ' selected' : ''}" data-id="${p.id}">
      <span class="dot ${p.gender}"></span>
      <div style="flex:1;min-width:0">
        <div class="p-name">${esc(p.name || '未命名')} ${state.egoId === p.id ? '<span style="color:var(--ok);font-size:10px">[基准]</span>' : ''}</div>
        <div class="p-sub">第${p.gen ?? 0}辈${parNames ? ' · 父母：' + esc(parNames) : ''}${spNames ? ' · 配偶：' + esc(spNames) : ''}</div>
      </div>
    </div>`;
  }).join('');
  sideBody.innerHTML = `
    <div class="legend">
      <span><i class="dot male" style="display:inline-block"></i>男</span>
      <span><i class="dot female" style="display:inline-block"></i>女</span>
      <span>共 ${state.people.length} 人 · ${roots().length} 个支系</span>
    </div>
    <div class="section-title">人物列表 <span class="hint">点击行编辑</span></div>
    ${rows || '<div style="color:var(--ink-3);padding:20px 4px">暂无人物，点击「＋ 添加人物」。</div>'}
  `;
  sideBody.querySelectorAll('.person-row').forEach(r => {
    r.addEventListener('click', () => openEditor(r.dataset.id));
  });
}

/* ---------------- 支系 ---------------- */
function renderBranchesTab() {
  const rs = roots();
  if (!rs.length) {
    sideBody.innerHTML = '<div style="color:var(--ink-3);padding:20px 4px">暂无人物。</div>';
    return;
  }
  const cards = rs.map(r => {
    const all = branchMembers(r.id);
    const isCol = !!state.collapsed[r.id];
    const spouseIds = new Set();
    // 标注哪些是“配偶（无父母录入）”
    for (const m of all) {
      if (m.id === r.id) continue;
      if (!(m.parents || []).length) spouseIds.add(m.id);
    }
    const members = all.slice(1).sort((a, b) => (a.gen ?? 0) - (b.gen ?? 0) || (a.order ?? 0) - (b.order ?? 0));
    const mRows = members.map(m => `
      <div class="branch-member" data-id="${m.id}">
        <span class="dot ${m.gender}" style="width:8px;height:8px"></span>
        <span class="p-name">${esc(m.name || '未命名')}</span>
        ${spouseIds.has(m.id) ? '<span style="color:#c2410c;font-size:10px">配偶</span>' : `<span style="color:var(--ink-3);font-size:10px">第${m.gen ?? 0}辈</span>`}
      </div>`).join('');
    return `<div class="branch-card${isCol ? '' : ' open'}">
      <div class="branch-head" data-id="${r.id}">
        <span class="caret">▶</span>
        <span class="dot ${r.gender}"></span>
        <span class="b-name">${esc(r.name || '未命名')} 支</span>
        <span class="b-count">${all.length} 人</span>
        <button class="btn btn-mini" style="padding:2px 8px" data-act="${isCol ? 'expand' : 'collapse'}" data-id="${r.id}">${isCol ? '展开' : '折叠'}</button>
      </div>
      <div class="branch-members">
        <div class="branch-member" data-id="${r.id}">
          <span class="dot ${r.gender}" style="width:8px;height:8px"></span>
          <span class="p-name">${esc(r.name || '未命名')}（始祖）</span>
        </div>
        ${mRows}
      </div>
    </div>`;
  }).join('');
  sideBody.innerHTML = `
    <div class="section-title">支系结构 <span class="hint">按无父母记录的始祖划分</span></div>
    ${cards}
  `;
  sideBody.querySelectorAll('.branch-head').forEach(h => {
    h.addEventListener('click', ev => {
      if (ev.target.dataset.act) {
        ev.stopPropagation();
        const id = ev.target.dataset.id;
        if (ev.target.dataset.act === 'collapse') state.collapsed[id] = true;
        else delete state.collapsed[id];
        save(); renderAll();
        return;
      }
      openEditor(h.dataset.id);
    });
  });
  sideBody.querySelectorAll('.branch-member').forEach(m => {
    m.addEventListener('click', () => openEditor(m.dataset.id));
  });
}

/* ---------------- 称谓演算 ---------------- */
function renderKinTab() {
  if (!state.egoId) {
    sideBody.innerHTML = `<div class="editor-empty">
      先在画布上<b>双击</b>任意人物节点，将其设为称谓基准（“我”），<br>
      系统会沿亲生/收养/继亲/配偶关系推导所有人与 TA 的称谓。<br><br>
      <span class="mini-link" id="pickEgo">选择第一位人物作为基准 →</span>
    </div>`;
    const link = sideBody.querySelector('#pickEgo');
    if (link) link.addEventListener('click', () => {
      if (state.people[0]) { state.egoId = state.people[0].id; save(); renderAll(); }
    });
    return;
  }
  const ego = byId(state.egoId);
  const others = state.people.filter(p => p.id !== state.egoId)
    .sort((a, b) => (a.gen ?? 0) - (b.gen ?? 0) || (a.order ?? 0) - (b.order ?? 0));

  const rows = others.map(t => {
    const k = displayKinship(state.egoId, t.id);
    const key = state.egoId + '>>' + t.id;
    const editing = state._kinEdit === key;
    const custom = state.customTerms[key] || {};
    const rtClass = 'rt-' + String(k.relType).replace('·', '');
    return `<div class="kin-row${editing ? ' editing' : ''}" data-key="${esc(key)}" data-tid="${t.id}">
      <div class="kr-top">
        <span class="dot ${t.gender}"></span>
        <span class="kr-target" data-jump="${t.id}" title="在画布中定位">${esc(t.name || '未命名')}</span>
        <span class="rel-badge ${rtClass}">${esc(k.relType)}</span>
        <span class="kr-tag tag-${k.tag}">${k.tag}</span>
        <span class="kr-term ${k.custom ? 'custom' : ''}">${esc(k.term)}</span>
      </div>
      ${k.detail ? `<div class="kr-detail">${esc(k.detail)}</div>` : ''}
      ${k.placeholder && !k.custom ? '<div class="kr-detail" style="color:var(--warn)">占位称谓（含关系类型），可按家族习惯手工修正</div>' : ''}
      ${custom.note ? `<div class="kr-note-preview">📝 ${esc(custom.note)}</div>` : ''}
      <div class="kr-edit">
        <label style="font-size:11px;color:var(--ink-2)">自定义称谓（${esc(ego.name)} 称 ${esc(t.name)}）</label>
        <input class="kr-term-input" placeholder="例如：二大爷、大表嫂" value="${esc(custom.term || '')}">
        <textarea class="kr-notes" placeholder="备注：过继、干亲、称谓由来…">${esc(custom.note || '')}</textarea>
        <div class="kr-btns">
          <button class="btn primary" data-act="save">保存修正</button>
          <button class="btn" data-act="reset">恢复推导</button>
        </div>
      </div>
      ${!editing ? `<div class="kr-btns" style="margin-top:6px"><button class="btn" data-act="edit">✎ 修正称谓/备注</button></div>` : ''}
    </div>`;
  }).join('');

  sideBody.innerHTML = `
    <div class="section-title">
      称谓演算 · 基准「${esc(ego.name)}」
      <span class="hint mini-link" id="changeEgo">更换</span>
    </div>
    <div style="font-size:11px;color:var(--ink-3);margin-bottom:10px;line-height:1.6">
      徽标标明关系类型（血缘/收养/继亲/姻亲），下方为推导路径；蓝色为系统推导，粉色为手工修正。
      多条路径竞争时优先采用血缘最短路径。
    </div>
    ${rows || '<div style="color:var(--ink-3)">暂无其他人物。</div>'}
  `;
  sideBody.querySelector('#changeEgo').addEventListener('click', () => {
    state.egoId = null; save(); renderAll();
  });
  sideBody.querySelectorAll('.kin-row').forEach(row => {
    const key = row.dataset.key, tid = row.dataset.tid;
    row.querySelector('.kr-target').addEventListener('click', () => locatePerson(tid));
    row.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'edit') { state._kinEdit = key; renderSidebar(); }
        else if (act === 'save') {
          const term = row.querySelector('.kr-term-input').value.trim();
          const note = row.querySelector('.kr-notes').value.trim();
          if (term || note) state.customTerms[key] = { term, note };
          else delete state.customTerms[key];
          state._kinEdit = null; save(); renderAll();
          toast('称谓已保存');
        } else if (act === 'reset') {
          delete state.customTerms[key];
          state._kinEdit = null; save(); renderAll();
        }
      });
    });
  });
}

/* ---------------- 校验（异常集中展示） ---------------- */
function renderIssuesTab() {
  const issues = currentIssues();
  if (!issues.length) {
    sideBody.innerHTML = `<div class="issue-ok">✅<br>未发现关系冲突或辈分异常。</div>
      <div style="color:var(--ink-3);font-size:11px;text-align:center;line-height:1.8">
      保存人物、调整关系与导入 JSON 时都会自动校验；<br>阻断级问题将禁止保存，提示级问题确认后可继续。</div>`;
    return;
  }
  const blocks = issues.filter(i => i.level === 'block');
  const warns = issues.filter(i => i.level === 'warn');
  const rowHtml = i => `
    <div class="issue-row lv-${i.level}">
      <div class="ir-head">
        <span class="ir-level">${i.level === 'block' ? '阻断' : '提示'}</span>
        <span class="ir-type">${esc(ISSUE_TYPE_LABEL[i.type] || i.type)}</span>
      </div>
      <div class="ir-msg">${esc(i.msg)}</div>
      <div class="ir-people">
        ${i.personIds.map(id => `<span class="ir-person" data-id="${esc(id)}">◎ ${esc(nameOf(id))}</span>`).join('')}
      </div>
    </div>`;
  sideBody.innerHTML = `
    <div class="section-title">异常项 <span class="hint">点击人名定位到画布</span></div>
    ${blocks.length ? `<div class="section-title" style="color:var(--danger)">阻断级（${blocks.length}）<span class="hint">须修正后才能保存</span></div>${blocks.map(rowHtml).join('')}` : ''}
    ${warns.length ? `<div class="section-title" style="color:var(--warn)">提示级（${warns.length}）<span class="hint">确认后可继续</span></div>${warns.map(rowHtml).join('')}` : ''}
  `;
  sideBody.querySelectorAll('.ir-person').forEach(el => {
    el.addEventListener('click', () => locatePerson(el.dataset.id));
  });
}

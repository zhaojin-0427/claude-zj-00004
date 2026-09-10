/* =====================================================================
 * util.js —— 常量与通用工具
 * ===================================================================== */
'use strict';

const STORAGE_KEY = 'family-kin-board-v1'; // 沿用旧 key，加载时自动迁移旧格式
const STORAGE_VERSION = 2;
const NODE_W = 132, NODE_H = 78, GEN_GAP = 130, SIB_GAP = 42;
const COUPLE_GAP = 26;              // 配偶之间
const SIB_X = NODE_W + SIB_GAP;

const GENDER = [
  { v: 'male', label: '男' },
  { v: 'female', label: '女' },
  { v: 'unknown', label: '未知' },
];
const genderLabel = g => ({ male: '男', female: '女', unknown: '?' }[g] || '?');

/* 亲子关系类型：亲生 / 收养 / 继亲 */
const REL_TYPES = [
  { v: 'bio', label: '亲生' },
  { v: 'adopt', label: '收养' },
  { v: 'step', label: '继亲' },
];
const relTypeLabel = t => ({ bio: '亲生', adopt: '收养', step: '继亲' }[t] || '亲生');

/* 父母角色（槽位维度之一） */
const PARENT_ROLES = [
  { v: 'father', label: '父亲' },
  { v: 'mother', label: '母亲' },
];
const roleLabel = r => ({ father: '父亲', mother: '母亲' }[r] || '父母');

/* 画布/PNG 边线样式：亲生实线、非亲生（收养/继亲）紫色虚线、配偶粉色点线 */
const EDGE_STYLE = {
  bio:    { color: '#b9c3d4', dash: '',     width: 1.6 },
  nonbio: { color: '#a78bfa', dash: '6 4',  width: 1.6 },
  spouse: { color: '#f472b6', dash: '4 4',  width: 1.4 },
};
const edgeStyleOf = type => (type === 'bio' ? EDGE_STYLE.bio : EDGE_STYLE.nonbio);

function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/**
 * 通用模态框。
 * opts: { title, text, html, okText, cancelText, hideCancel }
 * 返回 Promise<boolean>：确定=true，取消/点遮罩=false。
 */
function showModal(opts) {
  return new Promise(resolve => {
    const o = typeof opts === 'string' ? { title: opts } : opts;
    document.getElementById('mTitle').textContent = o.title || '确认';
    const body = document.getElementById('mBody');
    if (o.html) body.innerHTML = o.html;
    else body.textContent = o.text || '';
    const mask = document.getElementById('modalMask');
    const okBtn = document.getElementById('mOk');
    const cancelBtn = document.getElementById('mCancel');
    okBtn.textContent = o.okText || '确定';
    cancelBtn.textContent = o.cancelText || '取消';
    cancelBtn.style.display = o.hideCancel ? 'none' : '';
    mask.classList.add('show');
    const done = v => {
      mask.classList.remove('show');
      okBtn.onclick = null; cancelBtn.onclick = null; mask.onclick = null;
      resolve(v);
    };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    mask.onclick = e => { if (e.target === mask) done(false); };
  });
}

function confirmModal(title, text) {
  return showModal({ title, text });
}

/** 以列表形式展示一组校验问题；返回用户是否选择继续（无取消按钮时恒为 true 的告知框） */
function showIssuesModal(title, issues, { okText = '确定', cancelText = '取消', hideCancel = false, intro = '' } = {}) {
  const html = (intro ? `<p style="margin:0 0 8px">${esc(intro)}</p>` : '') +
    issues.map(i => `<div class="m-issue lv-${i.level}">${i.level === 'block' ? '⛔' : '⚠️'} ${esc(i.msg)}</div>`).join('');
  return showModal({ title, html, okText, cancelText, hideCancel });
}

/** 严格解析整数：小数、非数字、空串均拒绝；allowEmpty 时空串返回 value=null */
function strictInt(raw, { allowEmpty = false } = {}) {
  const s = String(raw).trim();
  if (s === '') return allowEmpty ? { ok: true, value: null } : { ok: false };
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

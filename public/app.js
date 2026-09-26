'use strict';

/* ================= 全局状态与 API ================= */

let state = { data: { equipment: [], batches: [], cleanings: [] }, knownAllergens: [], trace: null, labelCheck: null };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败（${res.status}）`);
  return json;
}

async function loadState(showToast) {
  state = await api('GET', '/api/state');
  renderAll();
  if (showToast) toast('已根据最新记录重新推演');
}

/* ================= 工具 ================= */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function eqName(id) {
  const eq = state.data.equipment.find((x) => x.id === id);
  return eq ? eq.name : '（已删除设备）';
}

function fmtTime(t) {
  return t ? t.replace('T', ' ') : '';
}

function nowInput() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function guard(fn) {
  try { await fn(); } catch (err) { toast(err.message, true); }
}

/* ================= 标签页 ================= */

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  });
});

/* ================= 过敏原 chips 选择器 ================= */

/**
 * 渲染过敏原勾选区。
 * @param known: 服务端已知过敏原
 * @param selected: Set<string> 已勾选（就地修改）
 * @param extras: 本地新增的自定义过敏原数组（就地修改）
 */
function renderChips(container, known, selected, extras, onChange) {
  const all = [];
  [...known, ...extras].forEach((a) => { if (!all.includes(a)) all.push(a); });

  container.innerHTML = all.map((a) => {
    const isCustom = !known.includes(a);
    const checked = selected.has(a) ? ' checked' : '';
    return `<span class="chip${checked}${isCustom ? ' custom-chip' : ''}" data-a="${esc(a)}">`
      + `${esc(a)}${isCustom ? '<span class="x" data-remove="1" title="移除该自定义项">✕</span>' : ''}</span>`;
  }).join('');

  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const a = chip.dataset.a;
      if (e.target.dataset.remove) {
        const i = extras.indexOf(a);
        if (i !== -1) extras.splice(i, 1);
        selected.delete(a);
      } else {
        selected.has(a) ? selected.delete(a) : selected.add(a);
      }
      renderChips(container, known, selected, extras, onChange);
      if (onChange) onChange();
    });
  });
}

/* ================= 批次表单 ================= */

const batchUI = {
  selected: new Set(),
  extras: [],
  steps: [],
  // 包装标签声明：filled=false 表示「尚未填写」；filled=true 时 selected 可为空集
  label: { filled: false, selected: new Set(), extras: [] },
};

function resetBatchForm() {
  $('#batch-id').value = '';
  $('#batch-form').reset();
  $('#batch-time').value = nowInput();
  batchUI.selected = new Set();
  batchUI.extras = [];
  batchUI.steps = [];
  batchUI.label = { filled: false, selected: new Set(), extras: [] };
  syncLabelEditor();
  $('#batch-form-title').textContent = '新增批次';
  $('#batch-save').textContent = '保存批次';
  renderBatchFormParts();
}

/** 按 batchUI.label.filled 同步单选框与声明编辑区的显示状态。 */
function syncLabelEditor() {
  const v = batchUI.label.filled ? 'filled' : 'unfilled';
  const radio = $(`input[name="label-status"][value="${v}"]`);
  if (radio) radio.checked = true;
  $('#label-editor').classList.toggle('hidden', !batchUI.label.filled);
}

function renderBatchFormParts() {
  renderChips($('#batch-allergens'), state.knownAllergens, batchUI.selected, batchUI.extras);
  renderChips($('#label-allergens'), state.knownAllergens, batchUI.label.selected, batchUI.label.extras);
  renderSteps();
}

function renderSteps() {
  const wrap = $('#steps');
  if (!state.data.equipment.length) {
    wrap.innerHTML = '<p class="hint">请先到「设备管理」创建设备。</p>';
    return;
  }
  if (!batchUI.steps.length) batchUI.steps.push({ equipmentId: state.data.equipment[0].id, time: '', note: '' });

  const options = (cur) => state.data.equipment
    .map((eq) => `<option value="${esc(eq.id)}"${eq.id === cur ? ' selected' : ''}>${esc(eq.name)}</option>`)
    .join('');

  wrap.innerHTML = batchUI.steps.map((s, i) => `
    <div class="step-row" data-idx="${i}">
      <span class="step-order">${i + 1}</span>
      <select data-f="equipmentId">${options(s.equipmentId)}</select>
      <input type="datetime-local" step="60" data-f="time" value="${esc(s.time || '')}" title="留空则用批次时间" />
      <input type="text" data-f="note" maxlength="100" placeholder="备注（可选）" value="${esc(s.note || '')}" />
      <button type="button" class="btn btn-small" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-small" data-act="down" ${i === batchUI.steps.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="btn btn-small btn-danger" data-act="del">删</button>
    </div>
  `).join('');

  wrap.querySelectorAll('.step-row').forEach((row) => {
    const i = +row.dataset.idx;
    row.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('input', () => { batchUI.steps[i][inp.dataset.f] = inp.value; });
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      batchUI.steps.splice(i, 1);
      renderSteps();
    });
    row.querySelector('[data-act="up"]').addEventListener('click', () => {
      [batchUI.steps[i - 1], batchUI.steps[i]] = [batchUI.steps[i], batchUI.steps[i - 1]];
      renderSteps();
    });
    row.querySelector('[data-act="down"]').addEventListener('click', () => {
      [batchUI.steps[i + 1], batchUI.steps[i]] = [batchUI.steps[i], batchUI.steps[i + 1]];
      renderSteps();
    });
  });
}

$('#step-add').addEventListener('click', () => {
  if (!state.data.equipment.length) return toast('请先创建设备', true);
  const prev = batchUI.steps[batchUI.steps.length - 1];
  batchUI.steps.push({
    equipmentId: prev ? prev.equipmentId : state.data.equipment[0].id,
    time: '',
    note: '',
  });
  renderSteps();
});

$('#batch-custom-add').addEventListener('click', () => {
  const inp = $('#batch-custom');
  const name = inp.value.trim();
  if (!name) return;
  if (state.knownAllergens.includes(name) || batchUI.extras.includes(name)) {
    batchUI.selected.add(name);
  } else {
    batchUI.extras.push(name);
    batchUI.selected.add(name);
  }
  inp.value = '';
  renderBatchFormParts();
});

$$('input[name="label-status"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const checked = $('input[name="label-status"]:checked');
    batchUI.label.filled = !!checked && checked.value === 'filled';
    syncLabelEditor();
  });
});

$('#label-custom-add').addEventListener('click', () => {
  const inp = $('#label-custom');
  const name = inp.value.trim();
  if (!name) return;
  if (state.knownAllergens.includes(name) || batchUI.label.extras.includes(name)) {
    batchUI.label.selected.add(name);
  } else {
    batchUI.label.extras.push(name);
    batchUI.label.selected.add(name);
  }
  inp.value = '';
  renderChips($('#label-allergens'), state.knownAllergens, batchUI.label.selected, batchUI.label.extras);
});

$('#batch-cancel').addEventListener('click', resetBatchForm);

$('#batch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const payload = {
      name: $('#batch-name').value,
      time: $('#batch-time').value,
      allergens: [...batchUI.selected],
      // 尚未填写 → null；已填写 → 声明集合（允许为空集合）
      labelAllergens: batchUI.label.filled ? [...batchUI.label.selected] : null,
      steps: batchUI.steps.map((s) => ({
        equipmentId: s.equipmentId,
        time: s.time || null,
        note: s.note || '',
      })),
    };
    const id = $('#batch-id').value;
    state = await api(id ? 'PUT' : 'POST', id ? `/api/batches/${id}` : '/api/batches', payload);
    renderAll();
    resetBatchForm();
    toast(id ? '批次已更新并重新推演' : '批次已保存并推演');
  });
});

function editBatch(id) {
  const b = state.data.batches.find((x) => x.id === id);
  if (!b) return;
  $('#batch-id').value = b.id;
  $('#batch-name').value = b.name;
  $('#batch-time').value = b.time;
  batchUI.selected = new Set(b.allergens);
  batchUI.extras = [];
  batchUI.steps = b.steps.map((s) => ({ ...s, time: s.time || '' }));
  // 标签声明：null/缺失 → 尚未填写；数组（含空数组）→ 已填写
  batchUI.label = Array.isArray(b.labelAllergens)
    ? { filled: true, selected: new Set(b.labelAllergens), extras: [] }
    : { filled: false, selected: new Set(), extras: [] };
  syncLabelEditor();
  $('#batch-form-title').textContent = `编辑批次：${b.name}`;
  $('#batch-save').textContent = '保存修改';
  renderBatchFormParts();
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'batches'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-batches'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteBatch(id) {
  if (!confirm('确定删除该批次？删除后将按剩余记录重新推演。')) return;
  await guard(async () => {
    state = await api('DELETE', `/api/batches/${id}`);
    renderAll();
    if ($('#batch-id').value === id) resetBatchForm();
    toast('批次已删除并重新推演');
  });
}

function renderBatchList() {
  const wrap = $('#batch-list');
  if (!state.data.batches.length) {
    wrap.innerHTML = '<p class="hint">还没有批次，先在上方录入。</p>';
    return;
  }
  wrap.innerHTML = state.data.batches.map((b) => {
    const steps = b.steps.map((s, i) =>
      `<b>${i + 1}. ${esc(eqName(s.equipmentId))}</b>${s.time ? `（${fmtTime(s.time)}）` : '（默认批次时间）'}${s.note ? ` ${esc(s.note)}` : ''}`
    ).join(' → ');
    const labelHtml = b.labelAllergens == null
      ? '<span class="tag tag-muted">尚未填写</span>'
      : b.labelAllergens.length
        ? b.labelAllergens.map((a) => `<span class="tag tag-label">${esc(a)}</span>`).join('')
        : '<span class="tag tag-muted">空集合（声明不含任何过敏原）</span>';
    return `<div class="record">
      <div class="record-main">
        <div class="record-title">${esc(b.name)}</div>
        <div class="record-meta">${fmtTime(b.time)} · 配方：${
          b.allergens.map((a) => `<span class="tag tag-recipe">${esc(a)}</span>`).join('') || '无'
        }</div>
        <div class="record-meta">标签声明：${labelHtml}</div>
        <div class="step-line">${steps}</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-small" data-edit-batch="${b.id}">编辑</button>
        <button class="btn btn-small btn-danger" data-del-batch="${b.id}">删除</button>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-edit-batch]').forEach((btn) =>
    btn.addEventListener('click', () => editBatch(btn.dataset.editBatch)));
  wrap.querySelectorAll('[data-del-batch]').forEach((btn) =>
    btn.addEventListener('click', () => deleteBatch(btn.dataset.delBatch)));
}

/* ================= 清洗表单 ================= */

const cleaningUI = { selected: new Set(), extras: [] };

function resetCleaningForm() {
  $('#cleaning-id').value = '';
  $('#cleaning-form').reset();
  $('#cleaning-time').value = nowInput();
  cleaningUI.selected = new Set();
  cleaningUI.extras = [];
  $('#cleaning-form-title').textContent = '新增清洗记录';
  $('#cleaning-save').textContent = '保存清洗记录';
  renderCleaningFormParts();
}

function renderCleaningFormParts() {
  const sel = $('#cleaning-equipment');
  const cur = sel.value;
  sel.innerHTML = state.data.equipment.length
    ? state.data.equipment.map((eq) =>
        `<option value="${esc(eq.id)}"${eq.id === cur ? ' selected' : ''}>${esc(eq.name)}</option>`).join('')
    : '<option value="">（请先创建设备）</option>';
  renderChips($('#cleaning-allergens'), state.knownAllergens, cleaningUI.selected, cleaningUI.extras);
}

$('#cleaning-custom-add').addEventListener('click', () => {
  const inp = $('#cleaning-custom');
  const name = inp.value.trim();
  if (!name) return;
  if (state.knownAllergens.includes(name) || cleaningUI.extras.includes(name)) {
    cleaningUI.selected.add(name);
  } else {
    cleaningUI.extras.push(name);
    cleaningUI.selected.add(name);
  }
  inp.value = '';
  renderCleaningFormParts();
});

$('#cleaning-cancel').addEventListener('click', resetCleaningForm);

$('#cleaning-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const payload = {
      equipmentId: $('#cleaning-equipment').value,
      time: $('#cleaning-time').value,
      allergens: [...cleaningUI.selected],
      note: $('#cleaning-note').value,
    };
    const id = $('#cleaning-id').value;
    state = await api(id ? 'PUT' : 'POST', id ? `/api/cleanings/${id}` : '/api/cleanings', payload);
    renderAll();
    resetCleaningForm();
    toast(id ? '清洗记录已更新并重新推演' : '清洗记录已保存并推演');
  });
});

function editCleaning(id) {
  const c = state.data.cleanings.find((x) => x.id === id);
  if (!c) return;
  $('#cleaning-id').value = c.id;
  $('#cleaning-time').value = c.time;
  $('#cleaning-note').value = c.note || '';
  cleaningUI.selected = new Set(c.allergens);
  cleaningUI.extras = [];
  renderCleaningFormParts();
  $('#cleaning-equipment').value = c.equipmentId;
  $('#cleaning-form-title').textContent = '编辑清洗记录';
  $('#cleaning-save').textContent = '保存修改';
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'cleanings'));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-cleanings'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteCleaning(id) {
  if (!confirm('确定删除该清洗记录？删除后将按剩余记录重新推演。')) return;
  await guard(async () => {
    state = await api('DELETE', `/api/cleanings/${id}`);
    renderAll();
    if ($('#cleaning-id').value === id) resetCleaningForm();
    toast('清洗记录已删除并重新推演');
  });
}

function renderCleaningList() {
  const wrap = $('#cleaning-list');
  const list = [...state.data.cleanings].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  if (!list.length) {
    wrap.innerHTML = '<p class="hint">还没有清洗记录。</p>';
    return;
  }
  wrap.innerHTML = list.map((c) => `
    <div class="record">
      <div class="record-main">
        <div class="record-title">🧽 ${fmtTime(c.time)} · ${esc(eqName(c.equipmentId))}</div>
        <div class="record-meta">移除：${
          c.allergens.map((a) => `<span class="tag tag-clean">${esc(a)}</span>`).join('')
        }${c.note ? ' · ' + esc(c.note) : ''}</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-small" data-edit-c="${c.id}">编辑</button>
        <button class="btn btn-small btn-danger" data-del-c="${c.id}">删除</button>
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-edit-c]').forEach((btn) =>
    btn.addEventListener('click', () => editCleaning(btn.dataset.editC)));
  wrap.querySelectorAll('[data-del-c]').forEach((btn) =>
    btn.addEventListener('click', () => deleteCleaning(btn.dataset.delC)));
}

/* ================= 批次改期影响预览（只读试算） ================= */

const rescheduleUI = { result: null, batchId: '' };

function resetRescheduleForm() {
  $('#reschedule-form').reset();
  rescheduleUI.batchId = '';
  renderRescheduleBatchSelect(true);
  rescheduleUI.result = null;
  renderRescheduleResult();
}

/** 渲染批次下拉；首次渲染或选择项失效时默认选中时间最早的批次并预填其时间。 */
function renderRescheduleBatchSelect(selectFirst) {
  const sel = $('#reschedule-batch');
  if (!state.data.batches.length) {
    sel.innerHTML = '<option value="">（暂无批次，请先录入）</option>';
    $('#reschedule-summary').textContent = '';
    return;
  }
  const batches = [...state.data.batches].sort((a, b) =>
    a.time === b.time
      ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      : a.time < b.time ? -1 : 1
  );
  const prev = sel.value;
  sel.innerHTML = batches.map((b) =>
    `<option value="${esc(b.id)}">${esc(b.name)}（${fmtTime(b.time)}）</option>`
  ).join('');
  // 保留仍然有效的已选批次；首次渲染或失效时落到最早的批次。
  const keep = !selectFirst && prev && batches.some((b) => b.id === prev) ? prev : batches[0].id;
  sel.value = keep;
  // 仅在所选批次变化（或首次选择）时重置新时间，避免重渲染覆盖用户已输入但未提交的时间。
  syncRescheduleTime(keep !== rescheduleUI.batchId);
}

/** 同步平移规则摘要；resetTime=true 时把新时间输入框重置为所选批次的原批次时间。 */
function syncRescheduleTime(resetTime) {
  const b = state.data.batches.find((x) => x.id === $('#reschedule-batch').value);
  const summary = $('#reschedule-summary');
  if (!b) {
    summary.textContent = '';
    return;
  }
  if (resetTime) $('#reschedule-time').value = b.time;
  rescheduleUI.batchId = b.id;
  const explicit = b.steps.filter((s) => s.time).length;
  summary.textContent =
    `原批次时间 ${fmtTime(b.time)}；共 ${b.steps.length} 个设备步骤，其中 ${explicit} 个填写了时间（按分钟差平移）、` +
    `${b.steps.length - explicit} 个留空（沿用新批次时间）。其他批次与清洗记录不变。`;
}

function renderRescheduleParts() {
  renderRescheduleBatchSelect(false);
  // 记录增删改后，上次预览结果自动失效
  rescheduleUI.result = null;
  renderRescheduleResult();
}

$('#reschedule-batch').addEventListener('change', () => syncRescheduleTime(true));
$('#reschedule-reset').addEventListener('click', resetRescheduleForm);

$('#reschedule-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const batchId = $('#reschedule-batch').value;
    const newTime = $('#reschedule-time').value;
    if (!batchId) throw new Error('请先选择一个现有批次');
    if (!newTime) throw new Error('请输入新的批次时间');
    const { preview } = await api('POST', '/api/reschedule-preview', { batchId, newTime });
    rescheduleUI.result = preview;
    renderRescheduleResult();
  });
});

function rescheduleTags(list, recipeSet) {
  if (!list || !list.length) return '<span class="tag tag-muted">（无过敏原）</span>';
  return list.map((a) =>
    `<span class="tag ${recipeSet.has(a) ? 'tag-recipe' : 'tag-inherit'}">${esc(a)}</span>`
  ).join('');
}

function diffTags(list, kind) {
  if (!list.length) return '<span class="tag tag-muted">无</span>';
  const cls = kind === 'added' ? 'tag-danger' : 'tag-clean';
  const sign = kind === 'added' ? '＋' : '－';
  return list.map((a) => `<span class="tag ${cls}">${sign} ${esc(a)}</span>`).join('');
}

function renderRescheduleResult() {
  const wrap = $('#reschedule-result');
  const preview = rescheduleUI.result;
  if (!preview) {
    wrap.className = 'plan-result hidden';
    wrap.innerHTML = '';
    return;
  }

  const r = preview.rescheduled;
  const steps = preview.shiftedSteps.length
    ? `<div class="plan-block">
        <div class="plan-block-title">改期批次各设备步骤的时间变化</div>
        <table class="plan-table">
          <thead><tr><th>步骤</th><th>设备</th><th>改期前时间</th><th></th><th>改期后时间</th></tr></thead>
          <tbody>${preview.shiftedSteps.map((s) => `
            <tr>
              <td class="plan-batch-name">第 ${s.stepIndex + 1} 步${s.explicit ? '' : '<div class="plan-batch-time">原步骤留空</div>'}</td>
              <td>${esc(s.equipmentName)}</td>
              <td>${s.oldTime ? fmtTime(s.oldTime) : '<span class="tag tag-muted">留空</span>'}</td>
              <td class="plan-arrow">→</td>
              <td>${fmtTime(s.newTime)}${s.explicit ? '' : ' <span class="tag tag-muted">沿用批次时间</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const rows = preview.batches.map((b) => {
    const recipeSet = new Set(b.recipeAllergens);
    const timeCell = b.rescheduled
      ? `${fmtTime(b.oldTime)}<div class="plan-batch-time">↓ ${fmtTime(b.newTime)}</div>`
      : `${fmtTime(b.oldTime)}<div class="plan-batch-time">时间不变</div>`;
    return `<tr${b.rescheduled ? ' class="rs-target-row"' : ''}>
      <td class="plan-batch-name">${b.rescheduled ? '🗓️ ' : ''}${esc(b.name)}${b.rescheduled ? '（改期批次）' : ''}<div class="plan-batch-time">${timeCell}</div></td>
      <td>${diffTags(b.addedCrossAllergens, 'added')}<br>${diffTags(b.removedCrossAllergens, 'removed')}</td>
      <td>${rescheduleTags(b.afterFinalAllergens, recipeSet)}</td>
    </tr>`;
  }).join('');

  const affected = preview.batches.filter((b) => b.changed).length;
  const bannerCls = affected ? 'plan-banner plan-ok' : 'plan-banner plan-empty';
  const icon = affected ? '⚠️' : '🟰';
  const title = affected
    ? `${affected} 个批次的交叉污染过敏原发生变化`
    : '所有批次最终过敏原均无变化';

  wrap.className = 'plan-result';
  wrap.innerHTML = `
    <div class="${bannerCls}"><b>${icon} ${title}</b><div>${esc(preview.message)}</div></div>
    ${steps}
    <div class="plan-block">
      <div class="plan-block-title">逐批对比（按改期后的时间顺序）</div>
      <table class="plan-table rs-table">
        <thead><tr><th>批次</th><th>新增 / 消失的交叉污染过敏原</th><th>改期后最终过敏原</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">图例：<span class="tag tag-danger">＋ 新增交叉污染</span>
    <span class="tag tag-clean">－ 消失交叉污染</span>
    <span class="tag tag-recipe">配方自带</span>
    <span class="tag tag-inherit">交叉污染继承</span>。本次预览仅为内存试算，原始批次与清洗记录未发生任何写入或修改。</p>`;
}

/* ================= 清洗规划（只读试算） ================= */

const planUI = {
  allergen: null, // 单选
  targets: new Set(),
  candidates: [],
  result: null,
};

function resetPlanForm() {
  planUI.allergen = null;
  planUI.targets = new Set();
  planUI.candidates = [];
  planUI.result = null;
  renderPlannerParts();
  renderPlanResult();
}

function renderPlanAllergenChips() {
  const wrap = $('#plan-allergen');
  if (!state.knownAllergens.length) {
    wrap.innerHTML = '<span class="hint">暂无可选过敏原。</span>';
    return;
  }
  wrap.innerHTML = state.knownAllergens.map((a) =>
    `<span class="chip${planUI.allergen === a ? ' checked' : ''}" data-a="${esc(a)}" title="点击选择（单选）">${esc(a)}</span>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      planUI.allergen = planUI.allergen === chip.dataset.a ? null : chip.dataset.a;
      renderPlanAllergenChips();
    }));
}

function renderPlanTargetChips() {
  const wrap = $('#plan-targets');
  if (!state.data.batches.length) {
    wrap.innerHTML = '<span class="hint">暂无可选批次，请到「批次录入」先录入。</span>';
    return;
  }
  wrap.innerHTML = state.data.batches.map((b) =>
    `<span class="chip${planUI.targets.has(b.id) ? ' checked' : ''}" data-b="${esc(b.id)}">${esc(b.name)}</span>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = chip.dataset.b;
      planUI.targets.has(id) ? planUI.targets.delete(id) : planUI.targets.add(id);
      renderPlanTargetChips();
    }));
}

function renderPlanCandidates() {
  const wrap = $('#plan-candidates');
  if (!state.data.equipment.length) {
    wrap.innerHTML = '<p class="hint">请先到「设备管理」创建设备。</p>';
    return;
  }
  if (!planUI.candidates.length) {
    wrap.innerHTML = '<p class="hint">尚未添加候选位置；不添加时若目标批次已被污染将直接无解。</p>';
    return;
  }
  const options = (cur) => state.data.equipment
    .map((eq) => `<option value="${esc(eq.id)}"${eq.id === cur ? ' selected' : ''}>${esc(eq.name)}</option>`)
    .join('');

  wrap.innerHTML = planUI.candidates.map((c, i) => `
    <div class="step-row" data-idx="${i}">
      <span class="step-order" title="候选输入序号（字典序以此为准）">${i + 1}</span>
      <select data-f="equipmentId">${options(c.equipmentId)}</select>
      <input type="datetime-local" step="60" data-f="time" value="${esc(c.time || '')}" required title="候选清洗时间" />
      <input type="text" data-f="note" maxlength="100" placeholder="备注（可选）" value="${esc(c.note || '')}" />
      <button type="button" class="btn btn-small" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-small" data-act="down" ${i === planUI.candidates.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="btn btn-small btn-danger" data-act="del">删</button>
    </div>
  `).join('');

  wrap.querySelectorAll('.step-row').forEach((row) => {
    const i = +row.dataset.idx;
    row.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('input', () => { planUI.candidates[i][inp.dataset.f] = inp.value; });
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      planUI.candidates.splice(i, 1);
      renderPlanCandidates();
    });
    row.querySelector('[data-act="up"]').addEventListener('click', () => {
      [planUI.candidates[i - 1], planUI.candidates[i]] = [planUI.candidates[i], planUI.candidates[i - 1]];
      renderPlanCandidates();
    });
    row.querySelector('[data-act="down"]').addEventListener('click', () => {
      [planUI.candidates[i + 1], planUI.candidates[i]] = [planUI.candidates[i], planUI.candidates[i + 1]];
      renderPlanCandidates();
    });
  });
}

function renderPlannerParts() {
  // 记录发生增删改后，清理已失效的选择与过期结果
  if (planUI.allergen && !state.knownAllergens.includes(planUI.allergen)) planUI.allergen = null;
  for (const id of [...planUI.targets]) {
    if (!state.data.batches.some((b) => b.id === id)) planUI.targets.delete(id);
  }
  const eqIds = new Set(state.data.equipment.map((eq) => eq.id));
  planUI.candidates = planUI.candidates.filter((c) => eqIds.has(c.equipmentId));
  planUI.result = null;
  renderPlanAllergenChips();
  renderPlanTargetChips();
  renderPlanCandidates();
  renderPlanResult();
}

$('#plan-candidate-add').addEventListener('click', () => {
  if (!state.data.equipment.length) return toast('请先创建设备', true);
  if (planUI.candidates.length >= 10) return toast('候选清洗位置最多 10 个', true);
  const prev = planUI.candidates[planUI.candidates.length - 1];
  planUI.candidates.push({
    equipmentId: prev ? prev.equipmentId : state.data.equipment[0].id,
    time: nowInput(),
    note: '',
  });
  renderPlanCandidates();
});

$('#plan-reset').addEventListener('click', resetPlanForm);

$('#plan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    if (!planUI.allergen) throw new Error('请先选择一种过敏原');
    if (!planUI.targets.size) throw new Error('请至少选择一个目标批次');
    if (planUI.candidates.length > 10) throw new Error('候选清洗位置最多 10 个');
    planUI.candidates.forEach((c, i) => {
      if (!c.time) throw new Error(`第 ${i + 1} 个候选位置缺少清洗时间`);
    });
    const payload = {
      allergen: planUI.allergen,
      batchIds: [...planUI.targets],
      candidates: planUI.candidates.map((c) => ({
        equipmentId: c.equipmentId,
        time: c.time,
        note: c.note || '',
      })),
    };
    const { plan } = await api('POST', '/api/cleaning-plans', payload);
    planUI.result = plan;
    renderPlanResult();
  });
});

function planTags(list, focusAllergen, recipeSet) {
  if (!list || !list.length) return '<span class="tag tag-muted">（无过敏原）</span>';
  return list.map((a) => {
    let cls = 'tag-inherit';
    if (recipeSet && recipeSet.has(a)) cls = 'tag-recipe';
    if (a === focusAllergen) cls = 'tag-danger';
    return `<span class="tag ${cls}">${esc(a)}</span>`;
  }).join('');
}

function renderPlanResult() {
  const wrap = $('#plan-result');
  const plan = planUI.result;
  if (!plan) {
    wrap.className = 'plan-result hidden';
    wrap.innerHTML = '';
    return;
  }

  const bannerCls =
    plan.status === 'solved' ? 'plan-banner plan-ok'
    : plan.status === 'already-clean' ? 'plan-banner plan-empty'
    : 'plan-banner plan-fail';
  const icon = plan.status === 'solved' ? '✅' : plan.status === 'already-clean' ? '🟰' : '❌';
  const title =
    plan.status === 'solved' ? `最优方案：新增 ${plan.cleaningCount} 次清洗`
    : plan.status === 'already-clean' ? '空方案：无需新增清洗'
    : '无解';

  const positions = plan.positions.length
    ? `<div class="plan-block">
        <div class="plan-block-title">选用的候选清洗位置（${plan.positions.length} 个，每个仅移除「${esc(plan.allergen)}」）</div>
        <ol class="plan-positions">${plan.positions.map((p) =>
          `<li><b>#${p.candidateIndex + 1}</b> · ${fmtTime(p.time)} · ${esc(p.equipmentName)}${p.note ? ' · ' + esc(p.note) : ''}</li>`
        ).join('')}</ol>
      </div>`
    : plan.status === 'solved' || plan.status === 'already-clean'
      ? '<div class="plan-block"><div class="plan-block-title">选用的清洗位置：无（空方案）</div></div>'
      : '';

  const rows = plan.batches.map((b) => {
    const recipeSet = new Set(b.recipeAllergens);
    const recipeFlag = b.allergenInRecipe
      ? '<span class="tag tag-danger" title="配方自带，清洗无法消除">配方自带该过敏原</span>'
      : '';
    return `<tr>
      <td class="plan-batch-name">${esc(b.name)}<div class="plan-batch-time">${fmtTime(b.time)} ${recipeFlag}</div></td>
      <td>${planTags(b.beforeAllergens, plan.allergen, recipeSet)}</td>
      <td class="plan-arrow">→</td>
      <td>${planTags(b.afterAllergens, plan.allergen, recipeSet)}</td>
    </tr>`;
  }).join('');

  wrap.className = 'plan-result';
  wrap.innerHTML = `
    <div class="${bannerCls}"><b>${icon} ${title}</b><div>${esc(plan.message)}</div></div>
    ${positions}
    <div class="plan-block">
      <div class="plan-block-title">目标批次规划前后的过敏原集合</div>
      <table class="plan-table">
        <thead><tr><th>目标批次</th><th>规划前最终过敏原</th><th></th><th>规划后最终过敏原</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">该规划仅为试算结果，原始批次与清洗记录未发生任何写入或修改。</p>`;
}

/* ================= 设备管理 ================= */

function editEquipment(id) {
  const eq = state.data.equipment.find((x) => x.id === id);
  if (!eq) return;
  $('#equipment-id').value = eq.id;
  $('#equipment-name').value = eq.name;
  $('#equipment-save').textContent = '保存修改';
  $('#equipment-cancel').classList.remove('hidden');
}

function resetEquipmentForm() {
  $('#equipment-form').reset();
  $('#equipment-id').value = '';
  $('#equipment-save').textContent = '保存';
  $('#equipment-cancel').classList.add('hidden');
}

$('#equipment-cancel').addEventListener('click', resetEquipmentForm);

$('#equipment-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const id = $('#equipment-id').value;
    const body = { name: $('#equipment-name').value };
    state = await api(id ? 'PUT' : 'POST', id ? `/api/equipment/${id}` : '/api/equipment', body);
    renderAll();
    resetEquipmentForm();
    toast(id ? '设备已更新' : '设备已添加');
  });
});

async function deleteEquipment(id) {
  const usage = state.data.batches.filter((b) => b.steps.some((s) => s.equipmentId === id)).length;
  if (!confirm(`删除设备「${eqName(id)}」？\n该设备的清洗记录会一并删除；${
    usage ? `有 ${usage} 个批次使用过它，相关步骤会被移除，步骤清空的批次也将删除；` : ''
  }\n删除后自动重新推演。`)) return;
  await guard(async () => {
    state = await api('DELETE', `/api/equipment/${id}`);
    renderAll();
    resetEquipmentForm();
    toast('设备已删除并重新推演');
  });
}

function renderEquipmentList() {
  const wrap = $('#equipment-list');
  if (!state.data.equipment.length) {
    wrap.innerHTML = '<p class="hint">还没有设备。</p>';
    return;
  }
  wrap.innerHTML = state.data.equipment.map((eq) => {
    const usedBy = new Set(state.data.batches
      .filter((b) => b.steps.some((s) => s.equipmentId === eq.id))
      .map((b) => b.name));
    const cleans = state.data.cleanings.filter((c) => c.equipmentId === eq.id).length;
    return `<div class="record">
      <div class="record-main">
        <div class="record-title">⚙️ ${esc(eq.name)}</div>
        <div class="record-meta">${usedBy.size} 个批次使用过（${
          [...usedBy].map((n) => esc(n)).join('、') || '无'
        }） · ${cleans} 条清洗记录</div>
      </div>
      <div class="record-actions">
        <button class="btn btn-small" data-edit-eq="${eq.id}">编辑</button>
        <button class="btn btn-small btn-danger" data-del-eq="${eq.id}">删除</button>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-edit-eq]').forEach((btn) =>
    btn.addEventListener('click', () => editEquipment(btn.dataset.editEq)));
  wrap.querySelectorAll('[data-del-eq]').forEach((btn) =>
    btn.addEventListener('click', () => deleteEquipment(btn.dataset.delEq)));
}

/* ================= 来源链渲染 ================= */

function nodeHtml(nodeId, seen) {
  const node = state.trace.nodes[nodeId];
  if (!node) return '<span class="node-text">（来源缺失）</span>';
  if (node.kind === 'origin') {
    return `<span class="node-text">🌾 配方源头：批次「${esc(node.batchName)}」的配方含 <span class="tag tag-recipe">${esc(node.allergen)}</span></span>`;
  }
  // inherit
  if (seen.has(nodeId)) {
    return `<span class="node-text">↪ 「${esc(node.equipmentName)}」上的 ${esc(node.allergen)}（见上文）</span>`;
  }
  seen.add(nodeId);
  const summary = `<summary><span class="node-text">↘ 批次「${esc(node.acquiredBy.batchName)}」第 ${node.acquiredBy.stepIndex + 1} 步在「${esc(node.equipmentName)}」上继承了 <span class="tag tag-inherit">${esc(node.allergen)}</span></span></summary>`;
  const children = `<div class="kv"><span class="kv-label">该设备上的 ${esc(node.allergen)} 来自：</span>${treeHtml(node.sources, seen)}</div>`;
  return `<details class="source-details">${summary}${children}</details>`;
}

function treeHtml(nodeIds, seen = new Set()) {
  if (!nodeIds || !nodeIds.length) return '';
  return `<ul class="source-tree${seen.size ? '' : ' root'}">${nodeIds
    .map((id) => `<li class="source-node">${nodeHtml(id, seen)}</li>`)
    .join('')}</ul>`;
}

function residueHtml(residue) {
  const keys = Object.keys(residue);
  if (!keys.length) return '<span class="tag tag-muted">无残留（已清空）</span>';
  return `<ul class="residue-list">${keys.map((a) => `
    <li><span class="tag tag-danger">${esc(a)}</span>
      <details class="source-details" style="display:inline-block">
        <summary><span class="kv-label">查看来源链</span></summary>
        ${treeHtml(residue[a])}
      </details>
    </li>`).join('')}</ul>`;
}

/* ================= 推演结果渲染 ================= */

function renderTimeline() {
  const wrap = $('#timeline');
  if (!state.trace.timeline.length) {
    wrap.innerHTML = '<p class="hint">暂无可推演的事件（录入批次步骤或清洗记录后出现）。</p>';
    return;
  }
  wrap.innerHTML = state.trace.timeline.map((ev) => {
    if (ev.type === 'cleaning') {
      const noop = !ev.removed.length;
      const desc = `🧽 清洗设备「${esc(ev.equipmentName)}」`;
      const sub = noop
        ? `<span class="sub">勾选移除：${ev.requestedRemoval.map((a) => esc(a)).join('、') || '—'} —— 当时设备上并无这些过敏原，<b>本次清洗未改变残留</b></span>`
        : `<span class="sub">移除 ${ev.removed.map((a) => `<span class="tag tag-clean">${esc(a)}</span>`).join('')}${
            ev.requestedRemoval.filter((a) => !ev.removed.includes(a)).length
              ? '；未在设备上的勾选过敏原：' + ev.requestedRemoval.filter((a) => !ev.removed.includes(a)).map((a) => esc(a)).join('、')
              : ''
          }${ev.note ? ' · ' + esc(ev.note) : ''}</span>`;
      return `<details class="tl-event">
        <summary class="tl-summary">
          <span class="tl-time">${fmtTime(ev.time)}</span>
          <span class="tl-desc">${desc}<br/>${sub}</span>
          <span class="tl-arrow"></span>
        </summary>
        <div class="tl-detail">
          <div class="kv"><span class="kv-label">清洗后「${esc(ev.equipmentName)}」残留：</span></div>
          ${residueHtml(ev.residueAfter)}
        </div>
      </details>`;
    }
    const desc = `🏭 批次「${esc(ev.batchName)}」第 ${ev.stepIndex + 1} 步 → 使用「${esc(ev.equipmentName)}」`;
    const sub = `<span class="sub">${
      ev.inherited.length
        ? '继承：' + ev.inherited.map((x) => `<span class="tag tag-inherit">${esc(x.allergen)}</span>`).join('')
        : '未继承新过敏原'
    } · 新留渍：${
      ev.deposited.map((a) => `<span class="tag tag-recipe">${esc(a)}</span>`).join('') || '无新增'
    }${ev.stepNote ? ' · ' + esc(ev.stepNote) : ''}</span>`;
    return `<details class="tl-event">
      <summary class="tl-summary">
        <span class="tl-time">${fmtTime(ev.time)}</span>
        <span class="tl-desc">${desc}<br/>${sub}</span>
        <span class="tl-arrow"></span>
      </summary>
      <div class="tl-detail">
        ${ev.inherited.length ? `<div class="kv"><span class="kv-label">本步继承到的过敏原及来源：</span>${
          ev.inherited.map((x) =>
            `<div><span class="tag tag-inherit">${esc(x.allergen)}</span>${treeHtml(x.nodeIds)}</div>`).join('')
        }</div>` : '<div class="kv"><span class="kv-label">本步无继承。</span></div>'}
        <div class="kv"><span class="kv-label">事件后「${esc(ev.equipmentName)}」的全部残留：</span></div>
        ${residueHtml(ev.residueAfter)}
      </div>
    </details>`;
  }).join('');
}

function renderBatchResults() {
  const wrap = $('#batch-results');
  if (!state.trace.batches.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = state.trace.batches.map((b) => `
    <div class="result-card">
      <h3>📦 ${esc(b.name)}</h3>
      <div class="card-time">${fmtTime(b.time)}</div>
      <div class="result-section">
        <span class="lbl">配方自带：</span>${
          b.recipeAllergens.map((a) => `<span class="tag tag-recipe">${esc(a)}</span>`).join('') || '无'
        }
      </div>
      <div class="result-section">
        <span class="lbl">交叉污染继承：</span>${
          b.inheritedAllergens.map((a) => `<span class="tag tag-inherit">${esc(a)}</span>`).join('')
          || '<span class="tag tag-muted">无</span>'
        }
      </div>
      <div class="result-section">
        <span class="lbl">最终过敏原：</span>${
          b.finalAllergens.map((a) =>
            `<span class="tag ${b.recipeAllergens.includes(a) ? 'tag-recipe' : 'tag-inherit'}">${esc(a)}</span>`).join('')
          || '<span class="tag tag-muted">无</span>'
        }
      </div>
      <div class="result-section">
        <span class="lbl">传播来源链（点击逐步展开）：</span>
        ${b.finalAllergens.length
          ? b.finalAllergens.map((a) =>
              `<details class="source-details"><summary>${b.recipeAllergens.includes(a) ? '🌾' : '↘'} <b>${esc(a)}</b> 的来源</summary>${treeHtml(b.sources[a])}</details>`).join('')
          : '<div class="hint">本批无任何过敏原。</div>'}
      </div>
    </div>`).join('');
}

/* ================= 包装标签核对 ================= */

function labelDeclaredHtml(declared) {
  if (declared === null) return '<span class="tag tag-muted">尚未填写</span>';
  if (!declared.length) return '<span class="tag tag-muted">空集合（声明不含任何过敏原）</span>';
  return declared.map((a) => `<span class="tag tag-label">${esc(a)}</span>`).join('');
}

function labelMissingItemHtml(m) {
  if (m.origin === 'recipe') {
    return `<li><span class="tag tag-danger">${esc(m.allergen)}</span>`
      + '<span class="tag tag-recipe">来自本批配方</span></li>';
  }
  const f = m.first;
  const firstLine = f
    ? `<div class="label-first">首次继承：${fmtTime(f.time)} · ${esc(f.equipmentName)}（第 ${f.stepIndex + 1} 步）</div>`
    : '';
  const chain = m.nodeIds && m.nodeIds.length
    ? `<details class="source-details"><summary><span class="kv-label">逐级展开来源链</span></summary>${treeHtml(m.nodeIds)}</details>`
    : '';
  return `<li><span class="tag tag-danger">${esc(m.allergen)}</span>`
    + `<span class="tag tag-inherit">交叉污染</span>${firstLine}${chain}</li>`;
}

function renderLabelCheck() {
  const wrap = $('#label-check');
  const lc = state.labelCheck;
  if (!lc || !lc.batches || !lc.batches.length) {
    wrap.innerHTML = '<p class="hint">暂无批次可核对，请先到「批次录入」录入批次。</p>';
    return;
  }
  const s = lc.summary;
  const bannerCls = s.withMissing
    ? 'plan-banner plan-fail'
    : (s.withExtra || s.unfilled) ? 'plan-banner plan-empty' : 'plan-banner plan-ok';
  const icon = s.withMissing ? '🚨' : (s.withExtra || s.unfilled) ? 'ℹ️' : '✅';
  const title = s.withMissing
    ? `${s.withMissing} 个批次存在标签漏报`
    : (s.withExtra || s.unfilled)
      ? '无漏报；仍存在多报或尚未填写的批次'
      : '全部批次的标签声明与最终过敏原一致';
  const counts = `共 ${s.total} 批：✅ ${s.match} 批一致 · 🚨 ${s.withMissing} 批漏报 · ＋ ${s.withExtra} 批多报 · ⬜ ${s.unfilled} 批尚未填写`;

  const cards = lc.batches.map((b) => {
    let badge;
    if (b.status === 'unfilled') {
      badge = '<span class="tag tag-muted">⬜ 尚未填写</span>';
    } else if (b.status === 'match') {
      badge = '<span class="tag tag-clean">✅ 标签一致</span>';
    } else {
      badge = (b.missing.length ? `<span class="tag tag-danger">🚨 漏报 ${b.missing.length} 项</span>` : '')
        + (b.extra.length ? `<span class="tag tag-warn">＋ 多报 ${b.extra.length} 项</span>` : '');
    }
    const missingHtml = b.missing.length
      ? `<div class="result-section"><span class="lbl">🚨 漏报（最终含有但标签未声明）：</span>
          <ul class="label-miss-list">${b.missing.map(labelMissingItemHtml).join('')}</ul></div>`
      : '';
    const extraHtml = b.extra.length
      ? `<div class="result-section"><span class="lbl">＋ 多报（标签已声明但最终不含）：</span>${
          b.extra.map((a) => `<span class="tag tag-warn">${esc(a)}</span>`).join('')}</div>`
      : '';
    const consistentHtml = b.consistent.length
      ? `<div class="result-section"><span class="lbl">✅ 一致（声明且最终含有）：</span>${
          b.consistent.map((a) => `<span class="tag tag-clean">${esc(a)}</span>`).join('')}</div>`
      : '';
    const unfilledHtml = b.status === 'unfilled'
      ? '<div class="result-section hint">到「批次录入」编辑该批次并填写标签声明后，即可参与核对。</div>'
      : '';
    return `<div class="result-card">
      <h3>🏷️ ${esc(b.name)} ${badge}</h3>
      <div class="card-time">${fmtTime(b.time)}</div>
      <div class="result-section"><span class="lbl">标签声明：</span>${labelDeclaredHtml(b.declared)}</div>
      ${missingHtml}${extraHtml}${consistentHtml}${unfilledHtml}
    </div>`;
  }).join('');

  wrap.innerHTML = `<div class="${bannerCls}"><b>${icon} ${title}</b><div>${counts}</div></div>`
    + `<div class="card-grid">${cards}</div>`;
}

function renderEquipmentResults() {
  const wrap = $('#equipment-results');
  if (!state.trace.equipment.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = state.trace.equipment.map((eq) => `
    <div class="result-card">
      <h3>🧰 ${esc(eq.name)}</h3>
      <div class="card-time">推演结束时的残留</div>
      ${residueHtml(eq.residue)}
    </div>`).join('');
}

function renderResults() {
  const empty = !state.data.equipment.length && !state.data.batches.length && !state.data.cleanings.length;
  $('#results-empty').classList.toggle('hidden', !empty);
  $('#results-body').classList.toggle('hidden', empty);
  if (empty) return;
  renderTimeline();
  renderBatchResults();
  renderLabelCheck();
  renderEquipmentResults();
}

/* ================= 整体渲染 ================= */

function renderMeta() {
  const d = state.data;
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#meta').textContent =
    `设备 ${d.equipment.length} · 批次 ${d.batches.length} · 清洗 ${d.cleanings.length} · 推演 ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

function renderAll() {
  renderMeta();
  renderResults();
  renderBatchList();
  renderCleaningList();
  renderEquipmentList();
  // 表单中的 chips / 设备下拉同步刷新（保留当前勾选）
  renderChips($('#batch-allergens'), state.knownAllergens, batchUI.selected, batchUI.extras);
  renderChips($('#label-allergens'), state.knownAllergens, batchUI.label.selected, batchUI.label.extras);
  renderSteps();
  renderCleaningFormParts();
  // 清洗规划区同步刷新；记录变更后上次规划结果自动失效
  renderPlannerParts();
  // 批次改期预览区同步刷新；记录变更后上次预览结果自动失效
  renderRescheduleParts();
}

/* ================= 演示数据 / 重推演 ================= */

async function seedDemo() {
  await guard(async () => {
    state = await api('POST', '/api/seed-demo');
    renderAll();
    resetBatchForm();
    resetCleaningForm();
    toast('演示数据已载入并完成推演');
  });
}
$('#btn-seed-demo').addEventListener('click', seedDemo);
$('#btn-seed-empty').addEventListener('click', seedDemo);
$('#btn-recompute').addEventListener('click', () => loadState(true));

/* ================= 启动 ================= */

resetBatchForm();
resetCleaningForm();
loadState().catch((err) => toast('加载失败：' + err.message, true));

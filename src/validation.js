'use strict';

const { STANDARD_ALLERGENS } = require('./trace');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 接受 'YYYY-MM-DDTHH:MM' 或带秒的本地时间字符串。 */
function parseLocalTime(value, field) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} 必须是时间字符串`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim()
  );
  if (!m) throw new HttpError(400, `${field} 时间格式应为 YYYY-MM-DDTHH:MM`);
  const [, y, mo, d, h, mi, s] = m;
  const month = +mo,
    day = +d,
    hour = +h,
    min = +mi;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new HttpError(400, `${field} 日期不合法`);
  }
  if (hour > 23 || min > 59 || (s !== undefined && +s > 59)) {
    throw new HttpError(400, `${field} 时间不合法`);
  }
  // 规范化为分钟精度，返回字典序与时间序一致的格式。
  return `${y}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function cleanText(value, field, max = 100, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} 必须是字符串`);
  }
  const t = value.trim();
  if (!t && !allowEmpty) throw new HttpError(400, `${field} 不能为空`);
  if (t.length > max) throw new HttpError(400, `${field} 过长（最多 ${max} 字）`);
  return t;
}

function normalizeAllergenList(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} 必须是数组`);
  }
  if (value.length > 50) {
    throw new HttpError(400, `${field} 过敏原数量过多`);
  }
  const out = [];
  for (const item of value) {
    const name = cleanText(item, `${field} 中的过敏原`, 50);
    if (!out.includes(name)) out.push(name);
  }
  if (!allowEmpty && out.length === 0) {
    throw new HttpError(400, `${field} 至少选择一种过敏原`);
  }
  return out;
}

/** 合并录入数据中出现过的过敏原：内置目录在前，自定义按名称排序。 */
function knownAllergens(data) {
  const custom = new Set();
  const collect = (list) =>
    (list || []).forEach((a) => {
      if (!STANDARD_ALLERGENS.includes(a)) custom.add(a);
    });
  data.batches.forEach((b) => {
    collect(b.allergens);
    collect(b.labelAllergens);
  });
  data.cleanings.forEach((c) => collect(c.allergens));
  return [...STANDARD_ALLERGENS, ...[...custom].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))];
}

/** 校验并规范化批次（及其步骤）。 */
function normalizeBatchInput(body, data, { partial = false } = {}) {
  const patch = {};

  if (body.name !== undefined || !partial) {
    patch.name = cleanText(body.name, '批次名称', 100);
    const dup = data.batches.find(
      (b) => b.name === patch.name && b.id !== body.id
    );
    if (dup) throw new HttpError(409, `已存在同名批次「${patch.name}」`);
  }

  if (body.time !== undefined || !partial) {
    patch.time = parseLocalTime(body.time, '批次时间');
  }

  if (body.allergens !== undefined || !partial) {
    patch.allergens = normalizeAllergenList(body.allergens, '配方过敏原');
  }

  // 包装标签声明：null 表示「尚未填写」，空数组表示「已填写但声明不含
  // 任何过敏原」（空集合），两者含义不同；未传该字段时不改动已有声明。
  if (body.labelAllergens !== undefined) {
    if (body.labelAllergens === null) {
      patch.labelAllergens = null;
    } else {
      patch.labelAllergens = normalizeAllergenList(
        body.labelAllergens,
        '标签声明过敏原',
        { allowEmpty: true }
      );
    }
  }

  if (body.steps !== undefined || !partial) {
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      throw new HttpError(400, '每批至少需要一个使用设备的步骤');
    }
    if (body.steps.length > 50) {
      throw new HttpError(400, '步骤数量过多（最多 50）');
    }
    const eqIds = new Set(data.equipment.map((eq) => eq.id));
    patch.steps = body.steps.map((s, i) => {
      if (!s || typeof s !== 'object') {
        throw new HttpError(400, `第 ${i + 1} 个步骤格式不合法`);
      }
      if (!eqIds.has(s.equipmentId)) {
        throw new HttpError(400, `第 ${i + 1} 个步骤选择了不存在的设备`);
      }
      const step = {
        equipmentId: s.equipmentId,
        time:
          s.time === undefined || s.time === '' || s.time === null
            ? null
            : parseLocalTime(s.time, `第 ${i + 1} 个步骤时间`),
        note: s.note === undefined ? '' : cleanText(s.note, '步骤备注', 100, { allowEmpty: true }),
      };
      return step;
    });
  }

  return patch;
}

/** 校验并规范化清洗记录。 */
function normalizeCleaningInput(body, data) {
  const equipmentId = cleanText(body.equipmentId, '设备 ID', 100);
  if (!data.equipment.some((eq) => eq.id === equipmentId)) {
    throw new HttpError(400, '选择了不存在的设备');
  }
  return {
    equipmentId,
    time: parseLocalTime(body.time, '清洗时间'),
    allergens: normalizeAllergenList(body.allergens, '清洗移除的过敏原'),
    note: body.note === undefined ? '' : cleanText(body.note, '清洗备注', 100, { allowEmpty: true }),
  };
}

/** 校验并规范化清洗规划入参（只读试算，不落库）。 */
function normalizeCleaningPlanInput(body, data) {
  const allergen = cleanText(body && body.allergen, '过敏原', 50);

  if (!body || !Array.isArray(body.batchIds)) {
    throw new HttpError(400, '目标批次必须是数组');
  }
  if (body.batchIds.length === 0) {
    throw new HttpError(400, '请至少选择一个目标批次');
  }
  if (body.batchIds.length > data.batches.length + 100) {
    throw new HttpError(400, '目标批次数量过多');
  }
  const batchIds = [];
  for (const item of body.batchIds) {
    const id = cleanText(item, '目标批次 ID', 100);
    if (!data.batches.some((b) => b.id === id)) {
      throw new HttpError(400, '目标批次中包含不存在的批次');
    }
    if (!batchIds.includes(id)) batchIds.push(id);
  }

  if (body.candidates === undefined || body.candidates === null) {
    throw new HttpError(400, '候选清洗位置必须是数组');
  }
  if (!Array.isArray(body.candidates)) {
    throw new HttpError(400, '候选清洗位置必须是数组');
  }
  if (body.candidates.length > 10) {
    throw new HttpError(400, '候选清洗位置最多 10 个');
  }
  const eqIds = new Set(data.equipment.map((eq) => eq.id));
  const candidates = body.candidates.map((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new HttpError(400, `第 ${i + 1} 个候选位置格式不合法`);
    }
    const equipmentId = cleanText(c.equipmentId, `第 ${i + 1} 个候选位置的设备`, 100);
    if (!eqIds.has(equipmentId)) {
      throw new HttpError(400, `第 ${i + 1} 个候选位置选择了不存在的设备`);
    }
    return {
      equipmentId,
      time: parseLocalTime(c.time, `第 ${i + 1} 个候选位置的清洗时间`),
      note:
        c.note === undefined
          ? ''
          : cleanText(c.note, `第 ${i + 1} 个候选位置备注`, 100, { allowEmpty: true }),
    };
  });

  return { allergen, batchIds, candidates };
}

/** 校验并规范化批次改期预览入参（只读试算，不落库）。 */
function normalizeRescheduleInput(body, data) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  const batchId = cleanText(body.batchId, '批次 ID', 100);
  if (!data.batches.some((b) => b.id === batchId)) {
    throw new HttpError(400, '选择的批次不存在，请重新选择一个现有批次');
  }
  if (body.newTime === undefined || body.newTime === null || `${body.newTime}`.trim() === '') {
    throw new HttpError(400, '请输入新的批次时间');
  }
  const newTime = parseLocalTime(body.newTime, '新批次时间');
  return { batchId, newTime };
}

module.exports = {
  HttpError,
  parseLocalTime,
  cleanText,
  normalizeAllergenList,
  normalizeBatchInput,
  normalizeCleaningInput,
  normalizeCleaningPlanInput,
  normalizeRescheduleInput,
  knownAllergens,
};

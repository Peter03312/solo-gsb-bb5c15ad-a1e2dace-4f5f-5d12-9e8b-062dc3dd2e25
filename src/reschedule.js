'use strict';

const { trace } = require('./trace');
const { HttpError } = require('./validation');

/**
 * 批次改期影响预览引擎（纯试算）
 *
 * 选定一个已有批次并给出新的批次时间：
 *   - 该批次中「填写了时间」的设备步骤按「新批次时间 − 原批次时间」的
 *     分钟差整体平移；
 *   - 时间留空的步骤不平移，推演时继续回退使用新批次时间；
 *   - 其他批次、全部清洗记录的时间保持原样。
 *
 * 改期前与改期后各用同一个 trace() 推演引擎完整推演一遍（批次先继承后
 * 留渍、同一分钟清洗先于接触、清洗只移除勾选过敏原等规则因此完全一致），
 * 再逐批比较：
 *   - 新增的交叉污染过敏原：改期后的「继承过敏原」− 改期前的「继承过敏原」；
 *   - 消失的交叉污染过敏原：反向差集；
 *   - 改期后的最终过敏原集合（配方自带 ∪ 继承）。
 *
 * 本函数不读取也不写入持久化记录：入参先做防御性深拷贝，平移只发生在
 * 这份内存副本上。
 */

/**
 * 把 'YYYY-MM-DDTHH:MM' 换算为从 Unix 纪元起的「挂钟分钟数」。
 * 用 UTC 分量计算，避免运行环境夏令时等时区规则影响分钟差。
 */
function wallClockMinutes(time) {
  const y = +time.slice(0, 4);
  const mo = +time.slice(5, 7);
  const d = +time.slice(8, 10);
  const h = +time.slice(11, 13);
  const mi = +time.slice(14, 16);
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

/** 在挂钟分钟轴上平移 deltaMinutes，再格式化为 'YYYY-MM-DDTHH:MM'。 */
function shiftTime(time, deltaMinutes) {
  const total = wallClockMinutes(time) + deltaMinutes;
  const d = new Date(total * 60000);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(total) || year < 1900 || year > 2999) {
    throw new HttpError(
      400,
      '改期后存在超出可表示范围（1900–2999 年）的步骤时间，请缩小改期幅度'
    );
  }
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${year}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

function setDiff(a, b) {
  return a.filter((x) => !b.includes(x));
}

/**
 * @param {{equipment: Array, batches: Array, cleanings: Array}} baseData 原始记录
 * @param {{batchId: string, newTime: string}} input 已规范化的入参
 * @returns {object} 改期前后逐批对比
 */
function previewReschedule(baseData, input) {
  // 防御性拷贝：保证平移与试算绝不触碰调用方的原始记录。
  const data = structuredClone(baseData);
  const { batchId, newTime } = input;

  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new HttpError(400, '批次不存在或已被删除，请重新选择');

  const oldTime = batch.time;
  const deltaMinutes = wallClockMinutes(newTime) - wallClockMinutes(oldTime);

  // ---- 构造改期后的内存副本（只动这一个批次） ---------------------------

  batch.time = newTime;
  const eqName = new Map(data.equipment.map((eq) => [eq.id, eq.name]));
  const shiftedSteps = (batch.steps || []).map((step, idx) => {
    if (step.time) {
      const oldStepTime = step.time;
      step.time = shiftTime(oldStepTime, deltaMinutes);
      return {
        stepIndex: idx,
        equipmentId: step.equipmentId,
        equipmentName: eqName.get(step.equipmentId) || step.equipmentId,
        explicit: true,
        oldTime: oldStepTime,
        newTime: step.time,
      };
    }
    return {
      stepIndex: idx,
      equipmentId: step.equipmentId,
      equipmentName: eqName.get(step.equipmentId) || step.equipmentId,
      explicit: false,
      oldTime: null,
      // 留空步骤：推演时回退使用新批次时间。
      newTime,
    };
  });

  // ---- 改期前 / 改期后各完整推演一遍 ------------------------------------

  const beforeTrace = trace(baseData);
  const afterTrace = trace(data);
  const beforeByBatch = new Map(beforeTrace.batches.map((b) => [b.batchId, b]));
  const afterByBatch = new Map(afterTrace.batches.map((b) => [b.batchId, b]));

  const batchRawTime = new Map(data.batches.map((b) => [b.id, b.time]));
  const originalTime = new Map(baseData.batches.map((b) => [b.id, b.time]));

  // trace 的批次结果已按（时间, id）排序，改期后顺序即用户直觉上的新排产顺序。
  const comparisons = afterTrace.batches.map((after) => {
    const before = beforeByBatch.get(after.batchId);
    const addedCross = setDiff(
      after.inheritedAllergens,
      before.inheritedAllergens
    );
    const removedCross = setDiff(
      before.inheritedAllergens,
      after.inheritedAllergens
    );
    const id = after.batchId;
    return {
      batchId: id,
      name: after.name,
      rescheduled: id === batchId,
      oldTime: originalTime.get(id),
      newTime: batchRawTime.get(id),
      recipeAllergens: after.recipeAllergens,
      beforeFinalAllergens: before.finalAllergens,
      afterFinalAllergens: after.finalAllergens,
      addedCrossAllergens: addedCross,
      removedCrossAllergens: removedCross,
      changed: addedCross.length > 0 || removedCross.length > 0,
    };
  });

  // ---- 摘要 -------------------------------------------------------------

  const abs = Math.abs(deltaMinutes);
  const direction =
    deltaMinutes === 0
      ? ''
      : deltaMinutes > 0
        ? `延后 ${abs} 分钟`
        : `提前 ${abs} 分钟`;
  const explicitCount = shiftedSteps.filter((s) => s.explicit).length;
  const blankCount = shiftedSteps.length - explicitCount;

  let message;
  if (deltaMinutes === 0) {
    message =
      `批次「${batch.name}」的新批次时间与原时间（${newTime.replace('T', ' ')}）相同，所有事件时刻均未变化，推演结果不变。`;
  } else {
    message =
      `批次「${batch.name}」改期：${oldTime.replace('T', ' ')} → ${newTime.replace('T', ' ')}（${direction}）。` +
      `该批次 ${shiftedSteps.length} 个设备步骤中，${explicitCount} 个已填时间的步骤按 ${abs} 分钟同步平移` +
      (blankCount ? `，${blankCount} 个留空步骤沿用新批次时间` : '') +
      '；其他批次与全部清洗记录保持原样。以下逐批比较改期前后的推演结果，本次预览只在内存中试算，未写入或修改任何原始记录。';
  }

  return {
    rescheduled: {
      batchId,
      name: batch.name,
      oldTime,
      newTime,
      deltaMinutes,
      direction,
    },
    shiftedSteps,
    unchangedBatches: data.batches.filter((b) => b.id !== batchId).length,
    unchangedCleanings: data.cleanings.length,
    message,
    batches: comparisons,
  };
}

module.exports = { previewReschedule, wallClockMinutes, shiftTime };

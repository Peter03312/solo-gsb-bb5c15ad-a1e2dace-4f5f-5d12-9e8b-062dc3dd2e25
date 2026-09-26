'use strict';

const { sortAllergens } = require('./trace');

/**
 * 包装标签核对引擎（纯函数，无副作用）
 *
 * 输入为原始记录 data 与一次最新的 trace() 推演结果，输出逐批的标签核对结论：
 *   - declared   ：该批标签声明的过敏原集合；null 表示「尚未填写」，
 *                  空数组表示「已填写、声明不含任何过敏原」（空集合），两者区分；
 *   - missing    ：漏报 = 最终过敏原中含有、但标签未声明的项。
 *                  配方自带项标 origin='recipe'（来自本批配方）；
 *                  交叉污染项标 origin='cross'，并给出首次继承的设备、时间、
 *                  步骤序号与来源节点 id 列表（复用 trace 的 nodes，可逐级展开）；
 *   - extra      ：多报 = 标签已声明、但最终过敏原中不含的项；
 *   - consistent ：一致 = 标签声明且最终确实含有的项；
 *   - status     ：'unfilled'（尚未填写）| 'match'（完全一致）| 'mismatch'（存在漏报/多报）。
 *
 * 核对完全由当前推演结果推导，本身不落库：上游批次或清洗记录改动后，
 * 只要重新推演，核对结果即随之更新，无需重新保存标签声明。
 * 标签声明（labelAllergens）保存在批次记录上，删除批次时随批次一并移除。
 *
 * @param {{equipment: Array, batches: Array, cleanings: Array}} data 原始记录
 * @param {object} traceResult trace(data) 的推演结果
 * @returns {object} { summary, batches }
 */
function checkLabels(data, traceResult) {
  // 每批每种过敏原的「首次继承」信息。时间线已按时间升序排列，
  // 某过敏原首次出现在该批接触事件的 inherited 中即首次继承；
  // （推演规则下同批同种过敏原至多继承一次：携带后不会重复继承。）
  const firstInherit = new Map(); // batchId -> Map(allergen -> info)
  for (const ev of traceResult.timeline || []) {
    if (ev.type !== 'contact') continue;
    for (const inh of ev.inherited || []) {
      let m = firstInherit.get(ev.batchId);
      if (!m) {
        m = new Map();
        firstInherit.set(ev.batchId, m);
      }
      if (!m.has(inh.allergen)) {
        m.set(inh.allergen, {
          time: ev.time,
          equipmentId: ev.equipmentId,
          equipmentName: ev.equipmentName,
          stepIndex: ev.stepIndex,
          nodeIds: [...(inh.nodeIds || [])],
        });
      }
    }
  }

  // 标签声明保存在批次记录上；历史数据没有该字段时视为「尚未填写」。
  const declaredById = new Map(
    (data.batches || []).map((b) => [
      b.id,
      Array.isArray(b.labelAllergens) ? sortAllergens(b.labelAllergens) : null,
    ])
  );

  // traceResult.batches 已按批次时间排序，核对结果沿用同一展示顺序。
  const batches = (traceResult.batches || []).map((br) => {
    const declared = declaredById.has(br.batchId)
      ? declaredById.get(br.batchId)
      : null;

    if (declared === null) {
      return {
        batchId: br.batchId,
        name: br.name,
        time: br.time,
        declared: null,
        status: 'unfilled',
        missing: [],
        extra: [],
        consistent: [],
      };
    }

    const declaredSet = new Set(declared);
    const recipeSet = new Set(br.recipeAllergens);
    const finalSet = new Set(br.finalAllergens);
    const inheritMap = firstInherit.get(br.batchId);

    const missing = br.finalAllergens
      .filter((a) => !declaredSet.has(a))
      .map((allergen) => {
        if (recipeSet.has(allergen)) {
          return { allergen, origin: 'recipe' };
        }
        const first = inheritMap ? inheritMap.get(allergen) : null;
        return {
          allergen,
          origin: 'cross',
          first: first
            ? {
                time: first.time,
                equipmentId: first.equipmentId,
                equipmentName: first.equipmentName,
                stepIndex: first.stepIndex,
              }
            : null,
          nodeIds: first ? first.nodeIds : [],
        };
      });
    const extra = declared.filter((a) => !finalSet.has(a));
    const consistent = declared.filter((a) => finalSet.has(a));

    return {
      batchId: br.batchId,
      name: br.name,
      time: br.time,
      declared,
      status: missing.length === 0 && extra.length === 0 ? 'match' : 'mismatch',
      missing,
      extra,
      consistent,
    };
  });

  const summary = {
    total: batches.length,
    unfilled: batches.filter((b) => b.status === 'unfilled').length,
    match: batches.filter((b) => b.status === 'match').length,
    withMissing: batches.filter((b) => b.missing.length > 0).length,
    withExtra: batches.filter((b) => b.extra.length > 0).length,
  };

  return { summary, batches };
}

module.exports = { checkLabels };

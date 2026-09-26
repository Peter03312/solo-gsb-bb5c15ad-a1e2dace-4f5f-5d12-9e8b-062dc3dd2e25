'use strict';

const { trace } = require('./trace');

/**
 * 清洗规划引擎（纯试算）
 *
 * 给定一种过敏原、一个或多个目标批次、至多 10 个候选清洗位置
 * （每个位置是「设备 + 时间」，且只会移除所选的那一种过敏原），
 * 在候选位置的所有子集中搜索：
 *
 *   1. 可行性：把该子集作为“虚拟清洗记录”追加到现有记录之后重新推演，
 *      所有目标批次的最终过敏原集合都不再包含所选过敏原；
 *   2. 最优性：可行子集中清洗次数最少；
 *   3. 并列规则：清洗次数相同时，按候选输入序号列表的字典序取最小者
 *      （例如 [0, 3] 优先于 [1, 2]）。
 *
 * 完全复用 trace() 推演引擎，因此批次“先继承后留渍”、清洗只移除勾选
 * 过敏原、同一分钟清洗先于接触等既有规则全部保持不变。
 *
 * 本函数不读取也不写入持久化记录：入参会被防御性深拷贝，虚拟清洗只
 * 存在于这次试算中；配方自带的过敏原批次天然无解。
 *
 * @param {{equipment: Array, batches: Array, cleanings: Array}} baseData 原始记录
 * @param {{allergen: string, batchIds: string[], candidates: Array}} input 已规范化的入参
 * @returns {object} 规划结果
 */
function planCleaning(baseData, input) {
  // 防御性拷贝：保证后续试算（追加虚拟清洗）绝不触碰调用方的原始记录。
  const data = structuredClone(baseData);
  const { allergen, batchIds, candidates } = input;

  const eqName = new Map(data.equipment.map((eq) => [eq.id, eq.name]));
  const describeCandidate = (c, index) => ({
    candidateIndex: index,
    equipmentId: c.equipmentId,
    equipmentName: eqName.get(c.equipmentId) || c.equipmentId,
    time: c.time,
    note: c.note || '',
  });

  // ---- 现状基线（规划前） ------------------------------------------------

  const baseline = trace(data);
  const baselineByBatch = new Map(
    baseline.batches.map((b) => [b.batchId, b])
  );

  const targets = batchIds.map((id) => {
    const raw = data.batches.find((b) => b.id === id);
    const tr = baselineByBatch.get(id);
    return {
      batchId: id,
      name: raw.name,
      time: raw.time,
      recipeAllergens: tr.recipeAllergens,
      // 配方自带该过敏原：任何设备清洗都无法消除，直接判定不可行。
      allergenInRecipe: tr.recipeAllergens.includes(allergen),
      beforeAllergens: tr.finalAllergens,
      afterAllergens: tr.finalAllergens,
    };
  });

  const buildResult = (status, message, chosen, finalTrace) => {
    const afterByBatch = finalTrace
      ? new Map(finalTrace.batches.map((b) => [b.batchId, b]))
      : null;
    return {
      allergen,
      status, // 'solved' | 'already-clean' | 'unsolvable'
      message,
      cleaningCount: chosen ? chosen.length : 0,
      positions: chosen
        ? chosen.map((i) => describeCandidate(candidates[i], i))
        : [],
      candidates: candidates.map((c, i) => describeCandidate(c, i)),
      batches: targets.map((t) => ({
        ...t,
        afterAllergens: afterByBatch
          ? afterByBatch.get(t.batchId).finalAllergens
          : t.beforeAllergens,
      })),
    };
  };

  // ---- 规则一：配方自带不可消除 ------------------------------------------

  const recipeBlocked = targets.filter((t) => t.allergenInRecipe);
  if (recipeBlocked.length > 0) {
    const names = recipeBlocked.map((t) => `「${t.name}」`).join('、');
    return buildResult(
      'unsolvable',
      `目标批次${names}的配方自带过敏原「${allergen}」；设备清洗只能移除设备上的交叉污染残留，无法消除批次配方自带的过敏原，因此无解。`,
      null,
      null
    );
  }

  // ---- 规则二：本来就干净 → 空方案 ---------------------------------------

  const contaminated = targets.filter((t) =>
    t.beforeAllergens.includes(allergen)
  );
  if (contaminated.length === 0) {
    return buildResult(
      'already-clean',
      `所有目标批次当前均已不含「${allergen}」，无需新增清洗，返回空方案。`,
      [],
      null
    );
  }

  // ---- 在候选位置的子集中搜索最优方案 ------------------------------------

  const baseCleaningLen = data.cleanings.length;

  /** 把给定候选序号集合作为虚拟清洗追加后推演，返回收尾状态与推演结果。 */
  const evaluate = (chosen) => {
    data.cleanings.length = baseCleaningLen;
    for (const i of chosen) {
      const c = candidates[i];
      data.cleanings.push({
        // 特殊前缀避免与真实清洗 id 冲突；同刻排序的次级键也保持稳定。
        id: `__plan_c_${i}`,
        equipmentId: c.equipmentId,
        time: c.time,
        allergens: [allergen], // 每个位置仅移除所选过敏原
        note: c.note || '',
      });
    }
    const t = trace(data);
    const ok = batchIds.every((id) => {
      const br = t.batches.find((b) => b.batchId === id);
      return !!br && !br.finalAllergens.includes(allergen);
    });
    return { ok, t };
  };

  /** 按字典序生成 {0,...,n-1} 中所有大小为 k 的下标组合（递增排列）。 */
  function* combinations(n, k) {
    const idx = Array.from({ length: k }, (_, i) => i);
    while (true) {
      yield idx.slice();
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i--;
      if (i < 0) return;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }

  // 清洗次数由少到多；同次数内组合天然按字典序枚举，首个可行解即最优解。
  let best = null;
  let bestTrace = null;
  outer: for (let k = 1; k <= candidates.length; k++) {
    for (const combo of combinations(candidates.length, k)) {
      const { ok, t } = evaluate(combo);
      if (ok) {
        best = combo;
        bestTrace = t;
        break outer;
      }
    }
  }
  data.cleanings.length = baseCleaningLen;

  if (!best) {
    return buildResult(
      'unsolvable',
      `在给出的 ${candidates.length} 个候选清洗位置中，任选子集都无法使所有目标批次最终不含「${allergen}」。` +
        '请调整候选位置：清洗必须早于目标批次接触带残留设备的时刻（同一分钟的清洗已自动按先于接触处理），且设备需位于污染传播路径上。',
      null,
      null
    );
  }

  return buildResult(
    'solved',
    `已找到清洗次数最少的方案：从 ${candidates.length} 个候选位置中选择 ${best.length} 个，` +
      `即可使所有目标批次最终均不含「${allergen}」。方案仅为试算结果，未写入或修改任何原始记录。`,
    best,
    bestTrace
  );
}

module.exports = { planCleaning };

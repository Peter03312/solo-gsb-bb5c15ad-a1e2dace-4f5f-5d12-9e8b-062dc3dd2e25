'use strict';

const { HttpError } = require('./validation');

/**
 * 配方源头传播范围查询引擎（纯函数，无副作用）
 *
 * 选定一个「源头」（某现有批次配方中的某种过敏原）后，基于一次最新
 * trace() 推演得到的来源节点表（trace.nodes），沿「继承节点的 sources
 * 指向其来源节点」的关系做正向可达分析，找出：
 *
 *   最终携带该过敏原、且来源链可追溯到所选批次配方源头的其他批次。
 *
 * 规则要点：
 *   - 传播经过多台设备、或多条路径在同一设备/批次汇合时，同一批次只列一次；
 *   - 每个命中批次给出首次继承该过敏原的设备、时间与步骤序号，以及一份
 *     可逐级展开至所选源头的来源节点 id 列表（前端复用 trace.nodes 展开）；
 *   - 源头批次自身不计入结果（只列「其他批次」）；配方自带该过敏原的批次
 *     不会从设备继承，其来源链不含所选源头，因此天然不会命中；
 *   - 过敏原被清洗移除后，设备残留中的对应来源即被截断，后续接触不会再
 *     继承，下游不会沿已截断的路径命中（由推演引擎天然保证，此处只对
 *     推演结果做只读分析）。
 *
 * 本模块不读取也不写入持久化记录：只对传入的推演结果做内存分析。
 */

/** 源头节点 id 的组成规则，与 trace.js 中 origin 节点的生成保持一致。 */
function originNodeId(batchId, allergen) {
  return `n_origin_${batchId}_${allergen}`;
}

/**
 * @param {object} traceResult trace(data) 的推演结果
 * @param {{batchId: string, allergen: string}} input 已规范化的入参
 * @returns {object} 传播范围查询结果
 */
function tracePropagation(traceResult, input) {
  const { batchId, allergen } = input;
  const nodes = traceResult.nodes || {};
  const originId = originNodeId(batchId, allergen);
  const origin = nodes[originId];
  // 入参已在 validation 层校验（批次存在、过敏原属于其配方），此处防御性兜底。
  if (!origin) {
    throw new HttpError(400, '所选批次的配方中不存在该过敏原源头，请刷新后重试');
  }

  // ---- 正向可达分析 -------------------------------------------------------
  // 来源边方向是「继承节点 -> 其来源节点」；把它反转成「来源 -> 继承者」，
  // 从所选源头节点出发遍历，即可得到全部可追溯到该源头的继承节点。
  const childrenOf = new Map(); // parentNodeId -> [childNodeId]
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'inherit') continue;
    for (const sid of node.sources || []) {
      let list = childrenOf.get(sid);
      if (!list) {
        list = [];
        childrenOf.set(sid, list);
      }
      list.push(node.id);
    }
  }
  const reachable = new Set([originId]);
  const queue = [originId];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of childrenOf.get(cur) || []) {
      if (!reachable.has(nxt)) {
        reachable.add(nxt);
        queue.push(nxt);
      }
    }
  }

  // ---- 每批每种过敏原的首次继承事件（时间线已按时间升序） ------------------
  // 推演规则下同批同种过敏原至多继承一次（携带后不会重复继承），
  // 因此时间线上首个出现的继承事件即首次继承。
  const firstInherit = new Map(); // batchId|allergen -> info
  for (const ev of traceResult.timeline || []) {
    if (ev.type !== 'contact') continue;
    for (const inh of ev.inherited || []) {
      const key = ev.batchId + '|' + inh.allergen;
      if (!firstInherit.has(key)) {
        firstInherit.set(key, {
          time: ev.time,
          equipmentId: ev.equipmentId,
          equipmentName: ev.equipmentName,
          stepIndex: ev.stepIndex,
        });
      }
    }
  }

  // ---- 收集命中批次（traceResult.batches 已按批次时间排序） ----------------
  const hits = [];
  for (const br of traceResult.batches || []) {
    if (br.batchId === batchId) continue; // 源头批次自身不计入「其他批次」
    if (!br.finalAllergens.includes(allergen)) continue;
    // 该批最终携带该过敏原的全部来源节点中，筛出可追溯到所选源头的部分；
    // 多路径汇合时只要任一来源可达即命中，且同一批次只列一次。
    const srcIds = (br.sources && br.sources[allergen]) || [];
    const hitNodeIds = srcIds.filter((id) => reachable.has(id));
    if (!hitNodeIds.length) continue;
    const first = firstInherit.get(br.batchId + '|' + allergen) || null;
    hits.push({
      batchId: br.batchId,
      name: br.name,
      time: br.time,
      first,
      nodeIds: hitNodeIds,
    });
  }

  const sourceBatch = (traceResult.batches || []).find(
    (b) => b.batchId === batchId
  );

  return {
    source: {
      batchId,
      name: origin.batchName,
      time: sourceBatch ? sourceBatch.time : null,
      allergen,
    },
    impactedCount: hits.length,
    batches: hits,
    message: hits.length
      ? `源头：批次「${origin.batchName}」配方中的「${allergen}」。共 ${hits.length} 个其他批次最终携带该过敏原且来源链可追溯到该源头；` +
        '传播经过多台设备或多条路径汇合时，同一批次只列一次。'
      : `源头：批次「${origin.batchName}」配方中的「${allergen}」。当前没有其他批次通过共用设备继承到该过敏原` +
        '（若传播中途被清洗移除，下游不会沿已截断的路径命中）。',
  };
}

module.exports = { tracePropagation, originNodeId };

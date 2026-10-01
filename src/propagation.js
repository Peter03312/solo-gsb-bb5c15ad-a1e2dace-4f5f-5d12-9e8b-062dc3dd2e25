'use strict';

/**
 * 配方源头传播范围查询（纯函数，只读）
 *
 * 基于一次最新 trace() 推演结果（trace.nodes 来源节点 + trace.batches 批次
 * 来源表 + trace.timeline 首次继承事件），回答：
 *
 *   「批次 S 配方中的过敏原 A，最终传播到了哪些其他批次？」
 *
 * 判定：某批次最终携带 A（finalAllergens 含 A），且其 A 的来源节点沿
 * nodes[].sources 向上回溯能到达 S 的配方源头节点（n_origin_S_A）。
 *
 * 性质：
 *   - 推演规则下同批同种过敏原至多继承一次，故每个命中批次有唯一的
 *     「首次继承」事件（设备 / 时间 / 步骤取自时间线）；
 *   - 传播经过多台设备或多条路径汇合（设备残留同时携带多条来源）时，
 *     同一批次只列出一次，并给出其中一条可回溯至所选源头的传播链
 *     （chain：节点 id 列表，末位恒为所选源头节点；节点详情见
 *     trace.nodes，与 labelCheck 的 nodeIds 同一约定）；
 *   - 清洗把过敏原从设备上移除后，后续接触不会再产生继承节点，已截断
 *     路径上不存在指向所选源头的来源链，因此下游天然不会命中；
 *   - 自身配方就含 A 的其他批次，其来源链指向自己的配方源头，不会被
 *     误算到所选批次头上；
 *   - 本模块只消费 trace() 的输出，不读取也不修改任何原始记录。
 */

/**
 * @param {object} traceResult trace(data) 的推演结果
 * @param {{batchId: string, allergen: string}} input 已规范化的入参
 * @returns {object} 传播范围查询结果
 */
function queryPropagation(traceResult, input) {
  const { batchId, allergen } = input;
  const nodes = traceResult.nodes || {};
  const originId = `n_origin_${batchId}_${allergen}`;
  const originNode = nodes[originId];
  if (!originNode) {
    // 入参已校验「过敏原属于该批配方」，源头节点必然存在；此处仅为防御。
    throw new Error(`推演结果中缺少源头节点（${batchId} / ${allergen}）`);
  }

  // ---- 首次继承表：batchId -> Map(allergen -> 首次继承事件信息) ----------
  // 时间线已按时间升序；同批同种过敏原至多继承一次，首次出现即唯一一次。
  const firstInherit = new Map();
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
        });
      }
    }
  }

  // ---- 可达性：节点沿 sources 回溯能否到达所选源头 ------------------------
  const reachMemo = new Map();
  const reachesOrigin = (nodeId) => {
    if (nodeId === originId) return true;
    if (reachMemo.has(nodeId)) return reachMemo.get(nodeId);
    const node = nodes[nodeId];
    let ok = false;
    if (node && node.kind === 'inherit') {
      reachMemo.set(nodeId, false); // 占位防环（来源链按时间严格向前，正常不会成环）
      ok = (node.sources || []).some(reachesOrigin);
    }
    reachMemo.set(nodeId, ok);
    return ok;
  };

  // ---- 从 startId 到所选源头的一条传播链 ----------------------------------
  const buildChain = (startId) => {
    const chain = [startId];
    let cur = startId;
    while (cur !== originId) {
      const node = nodes[cur];
      const next = ((node && node.sources) || []).find(reachesOrigin);
      if (!next) break; // 防御：已判定可达，正常不会走到这里
      chain.push(next);
      cur = next;
    }
    return chain;
  };

  // ---- 逐批判定（trace.batches 已按批次时间排序，沿用同一展示顺序） -------
  const affected = [];
  for (const br of traceResult.batches || []) {
    if (br.batchId === batchId) continue; // 源头批次自身不计入「其他批次」
    if (!(br.finalAllergens || []).includes(allergen)) continue;
    const sourceIds = (br.sources && br.sources[allergen]) || [];
    const startId = sourceIds.find(reachesOrigin);
    if (!startId) continue;
    const m = firstInherit.get(br.batchId);
    const first = m ? m.get(allergen) : null;
    affected.push({
      batchId: br.batchId,
      name: br.name,
      time: br.time,
      first: first
        ? {
            time: first.time,
            equipmentId: first.equipmentId,
            equipmentName: first.equipmentName,
            stepIndex: first.stepIndex,
          }
        : null,
      chain: buildChain(startId),
    });
  }

  const src = (traceResult.batches || []).find((b) => b.batchId === batchId);
  const source = {
    batchId,
    name: src ? src.name : originNode.batchName || batchId,
    time: src ? src.time : null,
    allergen,
  };

  const message = affected.length
    ? `批次「${source.name}」配方中的「${allergen}」最终传播到 ${affected.length} 个其他批次（按批次时间排序）。` +
      '同一批次经多台设备或多条路径汇合时只列出一次，传播链为其中一条可回溯至所选源头的路径。'
    : `批次「${source.name}」配方中的「${allergen}」未传播到任何其他批次。` +
      '若设备上的该过敏原在传播前已被清洗移除，已截断路径上的下游批次不会命中。';

  return {
    source,
    affectedCount: affected.length,
    affected,
    message,
  };
}

module.exports = { queryPropagation };

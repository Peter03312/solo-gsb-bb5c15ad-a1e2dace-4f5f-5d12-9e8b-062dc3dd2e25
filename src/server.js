'use strict';

const path = require('path');
const express = require('express');

const { JsonStore, newId } = require('./store');
const { trace } = require('./trace');
const { planCleaning } = require('./planner');
const { previewReschedule } = require('./reschedule');
const { checkLabels } = require('./labelcheck');
const { buildDemoData } = require('./demo');
const {
  HttpError,
  cleanText,
  normalizeBatchInput,
  normalizeCleaningInput,
  normalizeCleaningPlanInput,
  normalizeRescheduleInput,
  knownAllergens,
} = require('./validation');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_FILE =
  process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const store = new JsonStore(DATA_FILE);

function buildState() {
  const data = store.read();
  const traceResult = trace(data);
  return {
    data,
    knownAllergens: knownAllergens(data),
    trace: traceResult,
    // 标签核对完全由最新推演结果推导：任何记录变动后随状态一起返回，
    // 上游批次 / 清洗记录改动无需重新保存标签即可得到更新后的核对结果。
    labelCheck: checkLabels(data, traceResult),
  };
}

// ---- 查询 ---------------------------------------------------------------

app.get('/api/state', (req, res, next) => {
  try {
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

// ---- 设备 ---------------------------------------------------------------

app.post('/api/equipment', async (req, res, next) => {
  try {
    const name = cleanText(req.body && req.body.name, '设备名称', 100);
    const out = await store.mutate((d) => {
      if (d.equipment.some((eq) => eq.name === name)) {
        throw new HttpError(409, `已存在同名设备「${name}」`);
      }
      const eq = { id: newId('eq'), name };
      d.equipment.push(eq);
      return eq;
    });
    res.status(201).json(buildState());
  } catch (err) {
    next(err);
  }
});

app.put('/api/equipment/:id', async (req, res, next) => {
  try {
    const name = cleanText(req.body && req.body.name, '设备名称', 100);
    await store.mutate((d) => {
      const eq = d.equipment.find((x) => x.id === req.params.id);
      if (!eq) throw new HttpError(404, '设备不存在');
      if (d.equipment.some((x) => x.name === name && x.id !== eq.id)) {
        throw new HttpError(409, `已存在同名设备「${name}」`);
      }
      eq.name = name;
    });
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

app.delete('/api/equipment/:id', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const idx = d.equipment.findIndex((x) => x.id === req.params.id);
      if (idx === -1) throw new HttpError(404, '设备不存在');
      const id = req.params.id;
      d.equipment.splice(idx, 1);
      // 同步移除批次中使用该设备的步骤；步骤被清空的批次一并删除。
      d.batches = d.batches
        .map((b) => ({
          ...b,
          steps: (b.steps || []).filter((s) => s.equipmentId !== id),
        }))
        .filter((b) => b.steps.length > 0);
      d.cleanings = d.cleanings.filter((c) => c.equipmentId !== id);
    });
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

// ---- 批次 ---------------------------------------------------------------

app.post('/api/batches', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const patch = normalizeBatchInput(req.body || {}, d);
      // 未提交标签声明时默认「尚未填写」（null），与空集合声明区分。
      d.batches.push({ id: newId('b'), labelAllergens: null, ...patch });
    });
    res.status(201).json(buildState());
  } catch (err) {
    next(err);
  }
});

app.put('/api/batches/:id', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const batch = d.batches.find((x) => x.id === req.params.id);
      if (!batch) throw new HttpError(404, '批次不存在');
      const patch = normalizeBatchInput({ ...(req.body || {}), id: batch.id }, d);
      Object.assign(batch, patch);
    });
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

app.delete('/api/batches/:id', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const idx = d.batches.findIndex((x) => x.id === req.params.id);
      if (idx === -1) throw new HttpError(404, '批次不存在');
      d.batches.splice(idx, 1);
    });
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

// ---- 清洗 ---------------------------------------------------------------

app.post('/api/cleanings', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const patch = normalizeCleaningInput(req.body || {}, d);
      d.cleanings.push({ id: newId('c'), ...patch });
    });
    res.status(201).json(buildState());
  } catch (err) {
    next(err);
  }
});

app.put('/api/cleanings/:id', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const c = d.cleanings.find((x) => x.id === req.params.id);
      if (!c) throw new HttpError(404, '清洗记录不存在');
      Object.assign(c, normalizeCleaningInput(req.body || {}, d));
    });
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

app.delete('/api/cleanings/:id', async (req, res, next) => {
  try {
    await store.mutate((d) => {
      const idx = d.cleanings.findIndex((x) => x.id === req.params.id);
      if (idx === -1) throw new HttpError(404, '清洗记录不存在');
      d.cleanings.splice(idx, 1);
    });
    res.json(buildState());
  } catch (err) {
    next(err);
  }
});

// ---- 清洗规划（只读试算，绝不写入或修改原始记录） -----------------------

app.post('/api/cleaning-plans', (req, res, next) => {
  try {
    const data = store.read();
    const input = normalizeCleaningPlanInput(req.body || {}, data);
    res.json({ plan: planCleaning(data, input) });
  } catch (err) {
    next(err);
  }
});

// ---- 批次改期影响预览（只读试算，绝不写入或修改原始记录） ---------------

app.post('/api/reschedule-preview', (req, res, next) => {
  try {
    const data = store.read();
    const input = normalizeRescheduleInput(req.body || {}, data);
    res.json({ preview: previewReschedule(data, input) });
  } catch (err) {
    next(err);
  }
});

// ---- 演示数据 -----------------------------------------------------------

app.post('/api/seed-demo', async (req, res, next) => {
  try {
    const out = await store.mutate((d) => {
      if (d.equipment.length || d.batches.length || d.cleanings.length) {
        throw new HttpError(409, '当前已有记录，演示数据仅可写入空库，请先清空数据');
      }
      const demo = buildDemoData(newId);
      d.equipment = demo.equipment;
      d.batches = demo.batches;
      d.cleanings = demo.cleanings;
    });
    res.status(201).json(buildState());
  } catch (err) {
    next(err);
  }
});

// ---- 错误处理 -----------------------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

store
  .init()
  .then(async () => {
    // SEED_DEMO=1 且库为空时，启动即灌入演示数据（可选，便于快速体验）。
    if (process.env.SEED_DEMO === '1') {
      const d = store.read();
      if (!d.equipment.length && !d.batches.length && !d.cleanings.length) {
        const demo = buildDemoData(newId);
        await store.replaceAll(demo);
        console.log('[seed] 已写入演示数据');
      }
    }
    app.listen(PORT, () => {
      console.log(`过敏原残留追踪服务已启动: http://localhost:${PORT}`);
      console.log(`数据文件: ${DATA_FILE}`);
    });
  })
  .catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });

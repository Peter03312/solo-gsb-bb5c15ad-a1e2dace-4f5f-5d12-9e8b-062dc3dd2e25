'use strict';

/**
 * 基于 JSON 文件的轻量持久化。
 * 车间规模很小（批次/设备数量有限），全量读写 + 临时文件原子改名即可；
 * 单进程事件循环天然串行，再用一条 Promise 链把写请求排队落盘。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY_DATA = { equipment: [], batches: [], cleanings: [] };

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(EMPTY_DATA);
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        equipment: Array.isArray(parsed.equipment) ? parsed.equipment : [],
        batches: Array.isArray(parsed.batches) ? parsed.batches : [],
        cleanings: Array.isArray(parsed.cleanings) ? parsed.cleanings : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.persist();
    }
  }

  /** 返回数据的深拷贝，调用方可任意修改而不影响内部状态。 */
  read() {
    return structuredClone(this.data);
  }

  /** 在互斥队列中执行修改并原子落盘，返回修改后的深拷贝。 */
  async mutate(fn) {
    const run = this.writeChain.then(async () => {
      const draft = this.read();
      const result = await fn(draft);
      this.data = draft;
      await this.persist();
      return { data: this.read(), result };
    });
    // 保证即使本次写入失败，后续写请求仍可继续。
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async replaceAll(newData) {
    return this.mutate((draft) => {
      draft.equipment = newData.equipment || [];
      draft.batches = newData.batches || [];
      draft.cleanings = newData.cleanings || [];
    });
  }

  async persist() {
    const tmp = this.filePath + '.tmp-' + process.pid;
    await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.promises.rename(tmp, this.filePath);
  }
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

module.exports = { JsonStore, newId, EMPTY_DATA };

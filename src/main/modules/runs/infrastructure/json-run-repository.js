import { JsonStore } from '../../../shared/infrastructure/filesystem/json-store.js';
import { Run } from '../domain/run.aggregate.js';

export class JsonRunRepository {
  constructor(filePath) {
    this.store = new JsonStore(filePath, []);
  }

  async list() {
    const rows = await this.store.read();
    return rows.map((row) => Run.fromRecord(row));
  }

  async findById(id) {
    const rows = await this.store.read();
    const row = rows.find((item) => item.id === id);
    return row ? Run.fromRecord(row) : undefined;
  }

  async save(run) {
    const record = run.toRecord();
    await this.store.update((rows) => {
      const index = rows.findIndex((item) => item.id === run.id);
      if (index >= 0) rows[index] = record;
      else rows.push(record);
      return rows;
    });
  }

  // 串行化“读取最新状态-修改-保存”，避免运行结束回写与停止操作互相覆盖。
  async mutateById(id, mutate) {
    let found;
    await this.store.update((rows) => {
      const index = rows.findIndex((item) => item.id === id);
      if (index < 0) return rows;
      const run = Run.fromRecord(rows[index]);
      mutate(run);
      rows[index] = run.toRecord();
      found = run;
      return rows;
    });
    return found;
  }

  async deleteByIds(ids = []) {
    const idSet = new Set(ids);
    if (!idSet.size) return { deleted: 0 };

    let deleted = 0;
    await this.store.update((rows) => {
      const nextRows = rows.filter((item) => !idSet.has(item.id));
      deleted = rows.length - nextRows.length;
      return nextRows;
    });
    return { deleted };
  }
}

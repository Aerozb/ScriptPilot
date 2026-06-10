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
    const rows = await this.store.read();
    const index = rows.findIndex((item) => item.id === run.id);
    const record = run.toRecord();

    if (index >= 0) {
      rows[index] = record;
    } else {
      rows.push(record);
    }

    await this.store.write(rows);
  }

  async deleteByIds(ids = []) {
    const idSet = new Set(ids);
    if (!idSet.size) return { deleted: 0 };

    const rows = await this.store.read();
    const nextRows = rows.filter((item) => !idSet.has(item.id));
    await this.store.write(nextRows);
    return { deleted: rows.length - nextRows.length };
  }
}

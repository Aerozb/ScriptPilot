import { JsonStore } from '../../../shared/infrastructure/filesystem/json-store.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { Task } from '../domain/task.aggregate.js';

export class JsonTaskRepository {
  constructor(filePath) {
    this.store = new JsonStore(filePath, []);
  }

  async list() {
    const rows = await this.store.read();
    return rows.map((row) => Task.fromRecord(row));
  }

  async findById(id) {
    const rows = await this.store.read();
    const row = rows.find((item) => item.id === id);
    return row ? Task.fromRecord(row) : undefined;
  }

  async findByName(name) {
    const rows = await this.store.read();
    const row = rows.find((item) => item.name === name);
    return row ? Task.fromRecord(row) : undefined;
  }

  async save(task) {
    const record = task.toRecord();
    await this.store.update((rows) => {
      const index = rows.findIndex((item) => item.id === task.id);
      if (index >= 0) {
        rows[index] = record;
        return rows;
      }

      if (rows.some((item) => item.name === task.name)) {
        throw new AppError('TASK_NAME_EXISTS', `任务名称已存在: ${task.name}`);
      }

      rows.push(record);
      return rows;
    });
  }

  async deleteById(id) {
    await this.store.update((rows) => {
      const nextRows = rows.filter((item) => item.id !== id);
      if (nextRows.length === rows.length) {
        throw new AppError('TASK_NOT_FOUND', `任务不存在: ${id}`);
      }

      return nextRows;
    });
  }
}

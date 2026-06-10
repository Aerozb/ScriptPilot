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
    const rows = await this.store.read();
    const index = rows.findIndex((item) => item.id === task.id);
    const record = task.toRecord();

    if (index >= 0) {
      rows[index] = record;
    } else {
      if (rows.some((item) => item.name === task.name)) {
        throw new AppError('TASK_NAME_EXISTS', `任务名称已存在: ${task.name}`);
      }

      rows.push(record);
    }

    await this.store.write(rows);
  }

  async deleteById(id) {
    const rows = await this.store.read();
    const nextRows = rows.filter((item) => item.id !== id);
    if (nextRows.length === rows.length) {
      throw new AppError('TASK_NOT_FOUND', `任务不存在: ${id}`);
    }

    await this.store.write(nextRows);
  }
}

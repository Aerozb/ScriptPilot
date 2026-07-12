import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class JsonStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this.queue = Promise.resolve();
  }

  async read() {
    const value = await this.readOrRecover();
    if (value !== undefined) return value;
    await this.write(this.defaultValue);
    return structuredClone(this.defaultValue);
  }

  // 文件不存在返回 undefined；内容损坏时备份原文件并返回 undefined（自愈）。
  async readOrRecover() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }

    try {
      return JSON.parse(stripBom(raw));
    } catch {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      console.error(`数据文件损坏，已备份到 ${backupPath} 并重置: ${this.filePath}`);
      await copyFile(this.filePath, backupPath).catch(() => undefined);
      return undefined;
    }
  }

  write(value) {
    return this.enqueue(() => this.writeNow(value));
  }

  // 串行化“读-改-写”，避免并发调用互相覆盖丢失更新。
  update(mutate) {
    return this.enqueue(async () => {
      const current = await this.readOrRecover();
      const value = current === undefined ? structuredClone(this.defaultValue) : current;
      const next = await mutate(value);
      const result = next === undefined ? value : next;
      await this.writeNow(result);
      return result;
    });
  }

  enqueue(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async writeNow(value) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    // 显式 fsync：Windows 上进程被强杀或断电时，改名原子但数据可能未落盘，文件会变成全零。
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, this.filePath);
    } catch (error) {
      // Windows 上目标被占用时 rename 可能失败，退回先删后改名。
      if (process.platform !== 'win32') throw error;
      await rm(this.filePath, { force: true });
      await rename(tmpPath, this.filePath);
    }
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

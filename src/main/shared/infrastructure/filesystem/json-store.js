import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class JsonStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.write(this.defaultValue);
        return structuredClone(this.defaultValue);
      }

      throw error;
    }
  }

  async write(value) {
    this.writeQueue = this.writeQueue.then(() => this.writeNow(value), () => this.writeNow(value));
    return this.writeQueue;
  }

  async writeNow(value) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tmpPath, raw, 'utf8');
    if (process.platform === 'win32') {
      await rm(this.filePath, { force: true });
    }
    await rename(tmpPath, this.filePath);
  }
}

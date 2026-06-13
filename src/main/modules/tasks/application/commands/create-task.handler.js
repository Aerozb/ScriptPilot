import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandOk } from '../../../../shared/application/command-result.js';
import { assertInsidePath, resolvePortablePath, toPortablePath } from '../../../../bootstrap/portable-paths.js';
import { Task } from '../../domain/task.aggregate.js';
import { assertValidTaskSchedules } from '../task-schedule-validation.js';

export class CreateTaskHandler {
  constructor(deps) {
    this.paths = deps.paths;
    this.taskRepository = deps.taskRepository;
  }

  async handle(command) {
    const input = { ...command.payload };
    if (input.scriptContent) {
      input.scriptPath = await this.writeTaskScript(input);
    }

    normalizeTaskPaths(this.paths, input);

    assertValidTaskSchedules(input);

    const task = Task.create(input);
    await this.taskRepository.save(task);
    return commandOk({ taskId: task.id });
  }

  async writeTaskScript(input) {
    const scriptPath = input.scriptPath
      ? resolvePortablePath(this.paths, input.scriptPath, { label: '脚本保存路径' })
      : path.join(this.paths.scriptsRoot, 'tasks', `${Date.now()}-${sanitizeFileName(input.name || 'task')}.js`);
    assertInsidePath(this.paths.scriptsRoot, scriptPath, '脚本保存路径');
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, input.scriptContent, 'utf8');
    return toPortablePath(this.paths, scriptPath);
  }
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'task';
}

function normalizeTaskPaths(paths, input) {
  input.scriptPath = toPortablePath(paths, resolvePortablePath(paths, input.scriptPath, { label: '脚本路径' }), { label: '脚本路径' });
  if (input.cwd) {
    input.cwd = toPortablePath(paths, resolvePortablePath(paths, input.cwd, { label: '工作目录' }), { label: '工作目录' });
  }
}

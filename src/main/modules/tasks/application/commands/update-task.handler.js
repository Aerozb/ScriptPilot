import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';
import { assertValidCronExpression } from '../../../scheduler/infrastructure/cron-expression.js';
import { resolvePortablePath, toPortablePath } from '../../../../bootstrap/portable-paths.js';

export class UpdateTaskHandler {
  constructor(deps) {
    this.paths = deps.paths;
    this.taskRepository = deps.taskRepository;
  }

  async handle(command) {
    const taskId = command.payload?.taskId || command.payload?.id;
    if (!taskId) {
      throw new AppError('INVALID_TASK_ID', '任务 ID 不能为空');
    }

    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `任务不存在: ${taskId}`);
    }

    const input = { ...task.toRecord(), ...command.payload };
    if (command.payload.scriptContent) {
      input.scriptPath = await this.writeTaskScript(input);
    }

    normalizeTaskPaths(this.paths, input);

    if (input.cronExpression && !String(input.cronExpression).startsWith('@')) {
      assertValidCronExpression(input.cronExpression);
    }

    task.update(input);
    await this.taskRepository.save(task);
    return commandOk({ taskId: task.id });
  }

  async writeTaskScript(input) {
    const fileName = `${Date.now()}-${sanitizeFileName(input.name || 'task')}.js`;
    const scriptPath = path.join(this.paths.scriptsRoot, 'tasks', fileName);
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

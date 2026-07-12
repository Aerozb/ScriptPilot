import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';
import { assertValidCronExpression } from '../../../scheduler/infrastructure/cron-expression.js';
import { normalizeTaskPaths, writeTaskScript } from '../../infrastructure/task-script-writer.js';

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
      input.scriptPath = await writeTaskScript(this.paths, input);
    }

    normalizeTaskPaths(this.paths, input);

    if (input.cronExpression && !String(input.cronExpression).startsWith('@')) {
      assertValidCronExpression(input.cronExpression);
    }

    task.update(input);
    await this.taskRepository.save(task);
    return commandOk({ taskId: task.id });
  }
}

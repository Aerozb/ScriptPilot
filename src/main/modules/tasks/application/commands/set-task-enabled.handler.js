import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';

export class SetTaskEnabledHandler {
  constructor(taskRepository) {
    this.taskRepository = taskRepository;
  }

  async handle(command) {
    const taskId = command.payload?.taskId;
    if (!taskId) {
      throw new AppError('INVALID_TASK_ID', '任务 ID 不能为空');
    }

    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `任务不存在: ${taskId}`);
    }

    task.setEnabled(command.payload.enabled);
    await this.taskRepository.save(task);
    return commandOk({ taskId: task.id, enabled: task.enabled });
  }
}

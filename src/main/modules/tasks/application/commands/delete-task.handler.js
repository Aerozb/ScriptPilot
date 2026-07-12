import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';

export class DeleteTaskHandler {
  constructor(taskRepository) {
    this.taskRepository = taskRepository;
  }

  async handle(command) {
    const taskId = command.payload?.taskId;
    if (!taskId) {
      throw new AppError('INVALID_TASK_ID', '任务 ID 不能为空');
    }

    await this.taskRepository.deleteById(taskId);
    return commandOk({ taskId });
  }
}

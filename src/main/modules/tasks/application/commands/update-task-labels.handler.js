import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';

export class UpdateTaskLabelsHandler {
  constructor(taskRepository) {
    this.taskRepository = taskRepository;
  }

  async handle(command) {
    const ids = Array.isArray(command.payload?.ids) ? command.payload.ids : [];
    const labels = Array.isArray(command.payload?.labels) ? command.payload.labels : [];
    const action = command.payload?.action === 'remove' ? 'remove' : 'add';
    if (!ids.length) {
      throw new AppError('INVALID_TASK_IDS', '任务 ID 列表不能为空');
    }

    for (const taskId of ids) {
      const task = await this.taskRepository.findById(taskId);
      if (!task) continue;
      if (action === 'remove') task.removeLabels(labels);
      else task.addLabels(labels);
      await this.taskRepository.save(task);
    }

    return commandOk({ ids, labels, action });
  }
}

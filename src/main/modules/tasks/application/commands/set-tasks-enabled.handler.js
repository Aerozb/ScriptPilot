import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';

export class SetTasksEnabledHandler {
  constructor(taskRepository) {
    this.taskRepository = taskRepository;
  }

  async handle(command) {
    const ids = normalizeIds(command.payload?.ids);
    if (!ids.length) {
      throw new AppError('INVALID_TASK_ID', '任务 ID 不能为空');
    }

    const enabled = Boolean(command.payload.enabled);
    const tasks = await this.taskRepository.setEnabledMany(ids, enabled);
    return commandOk({
      ids: tasks.map((task) => task.id),
      enabled,
      results: tasks.map((task) => ({ taskId: task.id, enabled }))
    });
  }
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))];
}

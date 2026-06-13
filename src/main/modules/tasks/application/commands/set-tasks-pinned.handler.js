import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';

export class SetTasksPinnedHandler {
  constructor(taskRepository) {
    this.taskRepository = taskRepository;
  }

  async handle(command) {
    const ids = normalizeIds(command.payload?.ids);
    if (!ids.length) {
      throw new AppError('INVALID_TASK_ID', '任务 ID 不能为空');
    }

    const pinned = Boolean(command.payload.pinned);
    const tasks = await this.taskRepository.setPinnedMany(ids, pinned);
    return commandOk({
      ids: tasks.map((task) => task.id),
      pinned,
      results: tasks.map((task) => ({ taskId: task.id, pinned }))
    });
  }
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))];
}

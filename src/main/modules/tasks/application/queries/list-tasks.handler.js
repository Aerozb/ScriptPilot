export class ListTasksHandler {
  constructor(taskRepository) {
    this.taskRepository = taskRepository;
  }

  async handle() {
    const tasks = await this.taskRepository.list();
    const sorted = tasks.toSorted((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return {
      items: sorted.map((task) => ({
        id: task.id,
        name: task.name,
        scriptPath: task.scriptPath,
        cwd: task.cwd,
        args: task.args,
        params: task.params,
        dependencies: task.dependencies,
        cronExpression: task.cronExpression,
        extraSchedules: task.extraSchedules,
        labels: task.labels,
        allowMultipleInstances: task.allowMultipleInstances,
        logName: task.logName,
        beforeScript: task.beforeScript,
        afterScript: task.afterScript,
        remark: task.remark,
        pinned: task.pinned,
        enabled: task.enabled,
        timeoutMs: task.timeoutMs,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      }))
    };
  }
}

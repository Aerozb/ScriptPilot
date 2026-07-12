import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';

export class StopTaskRunHandler {
  constructor(deps) {
    this.runRepository = deps.runRepository;
    this.stopRunningNodeScript = deps.stopRunningNodeScript;
  }

  async handle(command) {
    const taskId = command.payload?.taskId;
    if (!taskId) {
      throw new AppError('INVALID_TASK_ID', '任务 ID 不能为空');
    }

    const runs = (await this.runRepository.list())
      .filter((item) => item.taskId === taskId && item.status === 'running')
      .toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    if (!runs.length) {
      return commandOk({ taskId, stopped: false, reason: '没有正在运行的实例' });
    }

    const stoppedRunIds = [];
    for (const run of runs) {
      const killed = this.stopRunningNodeScript(run.id);
      await this.runRepository.mutateById(run.id, (latestRun) => {
        if (latestRun.status === 'running') {
          latestRun.markStopped(killed ? '用户停止' : '运行进程已不存在');
        }
      });
      if (killed) stoppedRunIds.push(run.id);
    }

    return commandOk({
      taskId,
      runId: stoppedRunIds[0] || runs[0].id,
      stopped: stoppedRunIds.length > 0,
      stoppedCount: stoppedRunIds.length,
      ...(stoppedRunIds.length ? {} : { reason: '运行进程已不存在' })
    });
  }
}

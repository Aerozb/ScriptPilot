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

    const runs = await this.runRepository.list();
    const run = runs
      .filter((item) => item.taskId === taskId && item.status === 'running')
      .toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

    if (!run) {
      return commandOk({ taskId, stopped: false, reason: '没有正在运行的实例' });
    }

    const killed = this.stopRunningNodeScript(run.id);
    if (!killed) {
      run.markStopped('运行进程已不存在');
      await this.runRepository.save(run);
      return commandOk({ taskId, runId: run.id, stopped: false, reason: '运行进程已不存在' });
    }

    run.markStopped('用户停止');
    await this.runRepository.save(run);
    return commandOk({ taskId, runId: run.id, stopped: true });
  }
}

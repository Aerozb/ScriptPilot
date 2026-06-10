import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';
import { resolvePortablePath, toPortablePath } from '../../../../bootstrap/portable-paths.js';
import { createNodePathEnv } from '../../../dependencies/infrastructure/script-dependency-manager.js';
import { Run } from '../../domain/run.aggregate.js';

export class RunTaskNowHandler {
  constructor(deps) {
    this.paths = deps.paths;
    this.taskRepository = deps.taskRepository;
    this.runRepository = deps.runRepository;
    this.resolveNodeRuntime = deps.resolveNodeRuntime;
    this.runNodeScript = deps.runNodeScript;
    this.ensureScriptDependencies = deps.ensureScriptDependencies;
    this.stopRunningNodeScript = deps.stopRunningNodeScript;
  }

  async handle(command) {
    const task = await this.taskRepository.findById(command.payload.taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `任务不存在: ${command.payload.taskId}`);
    }

    const scriptPath = resolvePortablePath(this.paths, task.scriptPath, { label: '脚本路径' });
    await assertFileExists(scriptPath, 'SCRIPT_NOT_FOUND', `脚本文件不存在: ${task.scriptPath}`);
    if (!task.allowMultipleInstances && this.stopRunningNodeScript) {
      const running = (await this.runRepository.list())
        .filter((item) => item.taskId === task.id && item.status === 'running');
      for (const runningRun of running) {
        this.stopRunningNodeScript(runningRun.id);
        runningRun.markStopped('单实例模式自动停止旧实例');
        await this.runRepository.save(runningRun);
      }
    }

    const runtime = await this.resolveNodeRuntime(this.paths);
    const dependencyCheck = await this.ensureScriptDependencies({
      paths: this.paths,
      runtime,
      scriptPath,
      requestedDependencies: task.dependencies,
      autoInstall: true,
      forceCheck: false
    });
    const trigger = command.payload.trigger || 'manual';
    const run = Run.start({
      taskId: task.id,
      trigger,
      runtime,
      dependencyCheck,
      stdoutPath: '',
      stderrPath: ''
    });
    const logDir = path.join(this.paths.taskLogsRoot, task.id);
    const stdoutPath = path.join(logDir, `${run.id}.stdout.log`);
    const stderrPath = path.join(logDir, `${run.id}.stderr.log`);
    run.stdoutPath = toPortablePath(this.paths, stdoutPath);
    run.stderrPath = toPortablePath(this.paths, stderrPath);

    await this.runRepository.save(run);

    try {
      const result = await this.runNodeScript({
        runId: run.id,
        paths: this.paths,
        nodePath: runtime.nodePath,
        scriptPath,
        args: task.args,
        cwd: task.cwd ? resolvePortablePath(this.paths, task.cwd, { label: '工作目录' }) : this.paths.dataRoot,
        env: {
          SCRIPTPILOT_TASK_ID: task.id,
          SCRIPTPILOT_RUN_ID: run.id,
          SCRIPTPILOT_TRIGGER: trigger,
          SCRIPTPILOT_PARAMS: JSON.stringify(task.params || {}),
          NODE_PATH: createNodePathEnv(this.paths)
        },
        stdoutPath,
        stderrPath,
        timeoutMs: task.timeoutMs,
        onStarted: async ({ pid }) => {
          run.pid = pid;
          await this.runRepository.save(run);
        }
      });

      const latestRun = await this.runRepository.findById(run.id);
      if (latestRun?.status === 'stopped') {
        return commandOk({ runId: run.id });
      }
      run.markFinished(result);
    } catch (error) {
      run.markFailed(error);
    }

    await this.runRepository.save(run);
    return commandOk({ runId: run.id });
  }
}

async function assertFileExists(filePath, code, message) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new AppError(code, message, { filePath });
  }
}

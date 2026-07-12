import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError } from '../../../../shared/errors/app-error.js';
import { resolvePortablePath } from '../../../../bootstrap/portable-paths.js';
import { loadEnabledScriptEnv } from '../../infrastructure/script-process-env.js';
import { createRunBaseEnv, createRunWithLogPaths, executeScriptRun } from '../../infrastructure/script-run-executor.js';

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
        await this.runRepository.mutateById(runningRun.id, (latestRun) => {
          if (latestRun.status === 'running') latestRun.markStopped('单实例模式自动停止旧实例');
        });
      }
    }

    const runtime = await this.resolveNodeRuntime(this.paths);
    const enabledEnv = await loadEnabledScriptEnv(this.paths);
    const trigger = command.payload.trigger || 'manual';
    const { run, stdoutPath, stderrPath } = createRunWithLogPaths(this.paths, {
      taskId: task.id,
      name: task.name,
      scriptPath: task.scriptPath,
      trigger,
      runtime
    });

    await this.runRepository.save(run);

    return executeScriptRun({
      paths: this.paths,
      runRepository: this.runRepository,
      runNodeScript: this.runNodeScript,
      ensureScriptDependencies: this.ensureScriptDependencies
    }, {
      run,
      stdoutPath,
      stderrPath,
      name: task.name,
      runtime,
      scriptPath,
      requestedDependencies: task.dependencies,
      autoInstall: true,
      forceCheck: false,
      args: task.args,
      cwd: task.cwd ? resolvePortablePath(this.paths, task.cwd, { label: '工作目录' }) : this.paths.dataRoot,
      env: createRunBaseEnv(this.paths, runtime, {
        ...enabledEnv,
        SCRIPTPILOT_TASK_ID: task.id,
        SCRIPTPILOT_RUN_ID: run.id,
        SCRIPTPILOT_TRIGGER: trigger,
        SCRIPTPILOT_PARAMS: JSON.stringify(task.params || {})
      }),
      timeoutMs: task.timeoutMs,
      waitForCompletion: command.payload.waitForCompletion
    });
  }
}

async function assertFileExists(filePath, code, message) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new AppError(code, message, { filePath });
  }
}

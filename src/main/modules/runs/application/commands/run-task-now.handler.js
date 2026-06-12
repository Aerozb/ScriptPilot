import { access, appendFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';
import { resolvePortablePath, toPortablePath } from '../../../../bootstrap/portable-paths.js';
import { createNodePathEnv } from '../../../dependencies/infrastructure/script-dependency-manager.js';
import { loadEnabledScriptEnv } from '../../infrastructure/script-process-env.js';
import { runNodeScriptWithDependencyRetry } from '../../infrastructure/script-runner-with-retry.js';
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
    const enabledEnv = await loadEnabledScriptEnv(this.paths);
    const trigger = command.payload.trigger || 'manual';
    let dependencyCheck = {
      status: '等待依赖预检',
      reason: '运行开始后自动检查脚本依赖'
    };
    const run = Run.start({
      taskId: task.id,
      name: task.name,
      scriptPath: task.scriptPath,
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

    const executeRun = async () => {
      try {
        await appendRunnerLog(stdoutPath, 'ScriptPilot 正在检查脚本依赖...');
        dependencyCheck = await this.ensureScriptDependencies({
          paths: this.paths,
          runtime,
          scriptPath,
          requestedDependencies: task.dependencies,
          autoInstall: true,
          forceCheck: false
        });
        await this.updateRun(run.id, (latestRun) => {
          latestRun.dependencyCheck = dependencyCheck;
        });
        await appendRunnerLog(stdoutPath, formatDependencyCheckMessage(dependencyCheck));

        const latestBeforeSpawn = await this.runRepository.findById(run.id);
        if (latestBeforeSpawn?.status === 'stopped') return;

        const runInput = {
          runId: run.id,
          paths: this.paths,
          nodePath: runtime.nodePath,
          scriptPath,
          args: task.args,
          cwd: task.cwd ? resolvePortablePath(this.paths, task.cwd, { label: '工作目录' }) : this.paths.dataRoot,
          env: {
            ...enabledEnv,
            SCRIPTPILOT_TASK_ID: task.id,
            SCRIPTPILOT_RUN_ID: run.id,
            SCRIPTPILOT_TRIGGER: trigger,
            SCRIPTPILOT_PARAMS: JSON.stringify(task.params || {}),
            NODE_PATH: createNodePathEnv(this.paths)
          },
          stdoutPath,
          stderrPath,
          appendLog: true,
          timeoutMs: task.timeoutMs,
          onStarted: async ({ pid }) => {
            await this.updateRun(run.id, (latestRun) => {
              if (latestRun.status !== 'stopped') latestRun.pid = pid;
            });
          }
        };
        const { result, dependencyCheck: finalDependencyCheck } = await runNodeScriptWithDependencyRetry({
          runNodeScript: this.runNodeScript,
          ensureScriptDependencies: this.ensureScriptDependencies,
          paths: this.paths,
          runtime,
          scriptPath,
          requestedDependencies: task.dependencies,
          autoInstall: true,
          dependencyCheck,
          runInput
        });

        dependencyCheck = finalDependencyCheck;
        await this.updateRun(run.id, (latestRun) => {
          if (latestRun.status === 'stopped') return;
          latestRun.dependencyCheck = dependencyCheck;
          latestRun.markFinished(result);
        });
      } catch (error) {
        await appendRunnerLog(stderrPath, error.stack || error.message || String(error));
        await this.updateRun(run.id, (latestRun) => {
          if (latestRun.status !== 'stopped') latestRun.markFailed(error);
        });
      }
    };

    if (command.payload.waitForCompletion === false) {
      executeRun().catch((error) => {
        console.error(`任务后台运行失败: ${task.name}`, error);
      });
      return commandOk({ runId: run.id, started: true });
    }

    await executeRun();
    return commandOk({ runId: run.id });
  }

  async updateRun(runId, mutate) {
    const latestRun = await this.runRepository.findById(runId);
    if (!latestRun) return;
    mutate(latestRun);
    await this.runRepository.save(latestRun);
  }
}

async function assertFileExists(filePath, code, message) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new AppError(code, message, { filePath });
  }
}

async function appendRunnerLog(filePath, message) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`, 'utf8');
}

function formatDependencyCheckMessage(dependencyCheck = {}) {
  const installed = dependencyCheck.installed?.length ? `，安装：${dependencyCheck.installed.join(', ')}` : '';
  return `依赖预检完成：${dependencyCheck.status || '完成'}${installed}`;
}

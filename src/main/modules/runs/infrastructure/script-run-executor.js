import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { commandOk } from '../../../shared/application/command-result.js';
import { toPortablePath } from '../../../bootstrap/portable-paths.js';
import { createNodePathEnv } from '../../dependencies/infrastructure/script-dependency-manager.js';
import { runNodeScriptWithDependencyRetry } from './script-runner-with-retry.js';
import { Run } from '../domain/run.aggregate.js';

export const PENDING_DEPENDENCY_CHECK = {
  status: '等待依赖预检',
  reason: '运行开始后自动检查脚本依赖'
};

// 创建运行记录并生成对应日志文件路径。
export function createRunWithLogPaths(paths, input) {
  const run = Run.start({
    ...input,
    dependencyCheck: input.dependencyCheck || { ...PENDING_DEPENDENCY_CHECK },
    stdoutPath: '',
    stderrPath: ''
  });
  const logDir = path.join(paths.taskLogsRoot, input.taskId);
  const stdoutPath = path.join(logDir, `${run.id}.stdout.log`);
  const stderrPath = path.join(logDir, `${run.id}.stderr.log`);
  run.stdoutPath = toPortablePath(paths, stdoutPath);
  run.stderrPath = toPortablePath(paths, stderrPath);
  return { run, stdoutPath, stderrPath };
}

export function createRunBaseEnv(paths, runtime, extra = {}) {
  return {
    ...extra,
    NODE_PATH: createNodePathEnv(paths),
    // 开发模式下用 Electron 兜底运行时时，必须以纯 Node 模式执行脚本。
    ...(runtime?.source === 'current-process-dev-fallback' ? { ELECTRON_RUN_AS_NODE: '1' } : {})
  };
}

// 统一的脚本运行流程：依赖预检 -> 执行(缺依赖自动补装重试) -> 回写运行状态。
// deps: { paths, runRepository, runNodeScript, ensureScriptDependencies }
export async function executeScriptRun(deps, job) {
  const { paths, runRepository } = deps;
  const { run, stdoutPath, stderrPath } = job;

  const execute = async () => {
    try {
      await appendRunnerLog(stdoutPath, 'ScriptPilot 正在检查脚本依赖...');
      let dependencyCheck = await deps.ensureScriptDependencies({
        paths,
        runtime: job.runtime,
        scriptPath: job.scriptPath,
        scriptContent: job.scriptContent,
        requestedDependencies: job.requestedDependencies,
        autoInstall: job.autoInstall,
        forceCheck: job.forceCheck
      });
      await runRepository.mutateById(run.id, (latestRun) => {
        latestRun.dependencyCheck = dependencyCheck;
      });
      await appendRunnerLog(stdoutPath, formatDependencyCheckMessage(dependencyCheck));

      const latestBeforeSpawn = await runRepository.findById(run.id);
      if (latestBeforeSpawn?.status === 'stopped') return;

      const { result, dependencyCheck: finalDependencyCheck } = await runNodeScriptWithDependencyRetry({
        runNodeScript: deps.runNodeScript,
        ensureScriptDependencies: deps.ensureScriptDependencies,
        paths,
        runtime: job.runtime,
        scriptPath: job.scriptPath,
        scriptContent: job.scriptContent,
        requestedDependencies: job.requestedDependencies,
        autoInstall: job.autoInstall,
        dependencyCheck,
        runInput: {
          runId: run.id,
          paths,
          nodePath: job.runtime.nodePath,
          scriptPath: job.scriptPath,
          args: job.args,
          cwd: job.cwd,
          env: job.env,
          stdoutPath,
          stderrPath,
          appendLog: true,
          timeoutMs: job.timeoutMs,
          onStarted: ({ pid }) => {
            runRepository.mutateById(run.id, (latestRun) => {
              if (latestRun.status !== 'stopped') latestRun.pid = pid;
            }).catch(() => undefined);
          }
        }
      });

      dependencyCheck = finalDependencyCheck;
      await runRepository.mutateById(run.id, (latestRun) => {
        if (latestRun.status === 'stopped') return;
        latestRun.dependencyCheck = dependencyCheck;
        latestRun.markFinished(result);
      });
    } catch (error) {
      await appendRunnerLog(stderrPath, error.stack || error.message || String(error));
      await runRepository.mutateById(run.id, (latestRun) => {
        if (latestRun.status !== 'stopped') latestRun.markFailed(error);
      });
    }
  };

  if (job.waitForCompletion === false) {
    execute().catch((error) => {
      console.error(`脚本后台运行失败: ${job.name}`, error);
    });
    return commandOk({ runId: run.id, started: true });
  }

  await execute();
  return commandOk({ runId: run.id });
}

async function appendRunnerLog(filePath, message) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`, 'utf8');
}

function formatDependencyCheckMessage(dependencyCheck = {}) {
  const installed = dependencyCheck.installed?.length ? `，安装：${dependencyCheck.installed.join(', ')}` : '';
  return `依赖预检完成：${dependencyCheck.status || '完成'}${installed}`;
}

import { mkdir, writeFile, access, appendFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { commandOk } from '../../../../shared/application/command-result.js';
import { AppError } from '../../../../shared/errors/app-error.js';
import { resolvePortablePath, toPortablePath } from '../../../../bootstrap/portable-paths.js';
import { createNodePathEnv } from '../../../dependencies/infrastructure/script-dependency-manager.js';
import { loadEnabledScriptEnv } from '../../infrastructure/script-process-env.js';
import { runNodeScriptWithDependencyRetry } from '../../infrastructure/script-runner-with-retry.js';
import { Task } from '../../../tasks/domain/task.aggregate.js';
import { Run } from '../../domain/run.aggregate.js';

export class RunScriptOnceHandler {
  constructor(deps) {
    this.paths = deps.paths;
    this.runRepository = deps.runRepository;
    this.resolveNodeRuntime = deps.resolveNodeRuntime;
    this.runNodeScript = deps.runNodeScript;
    this.ensureScriptDependencies = deps.ensureScriptDependencies;
  }

  async handle(command) {
    const input = normalizeInput(command.payload);
    const scriptPath = await this.resolveScriptPath(input);
    const portableScriptPath = toPortablePath(this.paths, scriptPath);
    const cwd = input.cwd ? resolvePortablePath(this.paths, input.cwd, { label: '工作目录' }) : this.paths.dataRoot;
    const runtime = await this.resolveNodeRuntime(this.paths);
    const enabledEnv = await loadEnabledScriptEnv(this.paths);
    let dependencyCheck = {
      status: '等待依赖预检',
      reason: '运行开始后自动检查脚本依赖'
    };
    const tempTask = Task.create({
      name: input.name,
      scriptPath: portableScriptPath,
      cwd: input.cwd || 'data',
      args: input.args,
      params: input.params,
      enabled: false,
      timeoutMs: input.timeoutMs
    });

    const run = Run.start({
      taskId: tempTask.id,
      name: input.name,
      scriptPath: portableScriptPath,
      trigger: 'api',
      runtime,
      dependencyCheck,
      stdoutPath: '',
      stderrPath: ''
    });
    const logDir = path.join(this.paths.taskLogsRoot, tempTask.id);
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
          scriptContent: input.scriptContent,
          requestedDependencies: input.dependencies,
          autoInstall: input.autoInstallDependencies,
          forceCheck: input.forceDependencyCheck
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
          args: input.args,
          cwd,
          env: {
            ...enabledEnv,
            SCRIPTPILOT_TRIGGER: 'api',
            SCRIPTPILOT_TASK_ID: tempTask.id,
            SCRIPTPILOT_RUN_ID: run.id,
            SCRIPTPILOT_PARAMS: JSON.stringify(input.params || {}),
            NODE_PATH: createNodePathEnv(this.paths),
            ...sanitizeUserEnv(input.env || {})
          },
          stdoutPath,
          stderrPath,
          appendLog: true,
          timeoutMs: input.timeoutMs,
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
          scriptContent: input.scriptContent,
          requestedDependencies: input.dependencies,
          autoInstall: input.autoInstallDependencies,
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

    if (input.waitForCompletion === false) {
      executeRun().catch((error) => {
        console.error(`脚本后台运行失败: ${input.name}`, error);
      });
      return commandOk({ runId: run.id, started: true });
    }

    await executeRun();
    return commandOk({ runId: run.id });
  }

  async resolveScriptPath(input) {
    if (input.scriptContent) {
      const fileName = `${Date.now()}-${sanitizeFileName(input.name)}.js`;
      const scriptPath = path.join(this.paths.scriptsRoot, 'api', fileName);
      await mkdir(path.dirname(scriptPath), { recursive: true });
      await writeFile(scriptPath, input.scriptContent, 'utf8');
      return scriptPath;
    }

    const scriptPath = resolvePortablePath(this.paths, input.scriptPath, { label: '脚本路径' });
    try {
      await access(scriptPath, constants.R_OK);
    } catch {
      throw new AppError('SCRIPT_NOT_FOUND', `脚本文件不存在: ${input.scriptPath}`, { scriptPath });
    }
    return scriptPath;
  }

  async updateRun(runId, mutate) {
    const latestRun = await this.runRepository.findById(runId);
    if (!latestRun) return;
    mutate(latestRun);
    await this.runRepository.save(latestRun);
  }
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new AppError('INVALID_API_INPUT', '请求体必须是 JSON 对象');
  }

  if (!input.scriptPath && !input.scriptContent) {
    throw new AppError('SCRIPT_REQUIRED', '必须提供 scriptPath 或 scriptContent');
  }

  if (input.args !== undefined && !Array.isArray(input.args)) {
    throw new AppError('INVALID_ARGS', 'args 必须是字符串数组');
  }

  if (input.params !== undefined && (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params))) {
    throw new AppError('INVALID_PARAMS', 'params 必须是 JSON 对象');
  }

  if (input.env !== undefined && (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env))) {
    throw new AppError('INVALID_ENV', 'env 必须是 JSON 对象');
  }

  if (input.dependencies !== undefined && !Array.isArray(input.dependencies)) {
    throw new AppError('INVALID_DEPENDENCIES', 'dependencies 必须是字符串数组');
  }

  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '接口运行脚本',
    scriptPath: input.scriptPath,
    scriptContent: input.scriptContent,
    cwd: input.cwd,
    args: (input.args || []).map(String),
    params: input.params || {},
    env: input.env && typeof input.env === 'object' ? input.env : {},
    dependencies: (input.dependencies || []).map(String),
    autoInstallDependencies: input.autoInstallDependencies !== false,
    forceDependencyCheck: input.forceDependencyCheck === true,
    waitForCompletion: input.waitForCompletion !== false,
    timeoutMs: Number.isInteger(input.timeoutMs) ? input.timeoutMs : 30000
  };
}

function sanitizeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'script';
}

function sanitizeUserEnv(env) {
  const protectedKeys = new Set([
    'SCRIPTPILOT_PORTABLE_ROOT',
    'SCRIPTPILOT_DATA_ROOT',
    'SCRIPTPILOT_TASK_ID',
    'SCRIPTPILOT_RUN_ID',
    'SCRIPTPILOT_TRIGGER',
    'SCRIPTPILOT_PARAMS',
    'QL_DIR',
    'QL_DATA_DIR',
    'QL_NODE_GLOBAL_PATH',
    'NODE_PATH',
    'TMP',
    'TEMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CACHE_HOME',
    'npm_config_cache',
    'npm_config_prefix',
    'npm_config_userconfig',
    'npm_config_update_notifier'
  ]);
  return Object.fromEntries(
    Object.entries(env || {})
      .filter(([key]) => !protectedKeys.has(String(key)))
      .map(([key, value]) => [key, String(value)])
  );
}

async function appendRunnerLog(filePath, message) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`, 'utf8');
}

function formatDependencyCheckMessage(dependencyCheck = {}) {
  const installed = dependencyCheck.installed?.length ? `，安装：${dependencyCheck.installed.join(', ')}` : '';
  return `依赖预检完成：${dependencyCheck.status || '完成'}${installed}`;
}

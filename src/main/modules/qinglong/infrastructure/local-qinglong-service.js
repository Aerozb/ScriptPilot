import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from '../../../shared/infrastructure/filesystem/json-store.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { createPortableProcessEnv, resolvePortablePath, toPortablePath } from '../../../bootstrap/portable-paths.js';
import { resolveNodeRuntime } from '../../runtime/infrastructure/node-runtime-resolver.js';
import { Run } from '../../runs/domain/run.aggregate.js';
import { Task } from '../../tasks/domain/task.aggregate.js';
import { assertValidCronExpression } from '../../scheduler/infrastructure/cron-expression.js';
import { assertInside, normalizeScriptRelative, pruneEmptyDirectories, sanitizeFileName, sanitizePathPart, toDataScriptPath } from './fs-utils.js';
import { createSubscriptionFolder, getSubscriptionSourceCachePath, parseSubscriptionSource } from './subscription-source.js';
import { pullSubscriptionFiles } from './subscription-puller.js';
import { createTaskNameFromScriptPath, extractScriptCron } from './script-cron.js';

const DEFAULT_CONFIGS = {
  'config.sh': '# ScriptPilot 本地青龙版配置\nexport QL_DIR=\"$PWD\"\n',
  'notify.js': 'module.exports = async function notify(title, content) {\n  console.log(`[notify] ${title}: ${content}`);\n};\n',
  'extra.sh': '# 自定义 Shell 配置\n',
  'package.json': '{\n  "dependencies": {}\n}\n'
};

/*
 * 青龙式能力门面：环境变量、配置文件、脚本、订阅、依赖。
 * 订阅源解析与下载在 subscription-source.js / subscription-puller.js。
 */
export class LocalQinglongService {
  constructor(paths, deps = {}) {
    this.paths = paths;
    this.runRepository = deps.runRepository;
    this.taskRepository = deps.taskRepository;
    this.envStore = new JsonStore(path.join(paths.appStateRoot, 'envs.json'), []);
    this.subscriptionStore = new JsonStore(path.join(paths.appStateRoot, 'subscriptions.json'), []);
    this.dependencyHistoryStore = new JsonStore(path.join(paths.appStateRoot, 'dependency-history.json'), []);
    this.configRoot = path.join(paths.dataRoot, 'configs');
    this.scriptRoot = paths.scriptsRoot;
    this.repoRoot = paths.repoRoot;
    this.rawRoot = paths.rawRoot;
  }

  async getOverview() {
    const [envs, subscriptions, scripts, dependencies] = await Promise.all([
      this.listEnvs(),
      this.listSubscriptions(),
      this.listScripts(),
      this.listDependencies()
    ]);
    return {
      envCount: envs.items.length,
      enabledEnvCount: envs.items.filter((item) => item.status === 'enabled').length,
      subscriptionCount: subscriptions.items.length,
      scriptCount: scripts.items.length,
      dependencyCount: dependencies.items.length,
      paths: {
        dataRoot: this.paths.dataRoot,
        scriptsRoot: this.paths.scriptsRoot,
        configRoot: this.configRoot
      }
    };
  }

  // ---------- 环境变量 ----------

  async listEnvs() {
    const rows = await this.envStore.read();
    return { items: rows.toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()) };
  }

  async saveEnv(input) {
    if (!input?.name?.trim()) throw new AppError('INVALID_ENV_NAME', '变量名称不能为空');
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    const next = {
      id,
      name: input.name.trim(),
      value: String(input.value ?? ''),
      remarks: String(input.remarks ?? ''),
      status: input.status === 'disabled' ? 'disabled' : 'enabled',
      createdAt: input.createdAt || now,
      updatedAt: now
    };
    await this.envStore.update((rows) => {
      const index = rows.findIndex((item) => item.id === id);
      if (index >= 0) rows[index] = { ...rows[index], ...next, createdAt: rows[index].createdAt };
      else rows.push(next);
      return rows;
    });
    return next;
  }

  async deleteEnvs(ids = []) {
    const idSet = new Set(ids);
    await this.envStore.update((rows) => rows.filter((item) => !idSet.has(item.id)));
    return { deleted: ids.length };
  }

  async setEnvStatus(ids = [], status) {
    const idSet = new Set(ids);
    const now = new Date().toISOString();
    await this.envStore.update((rows) =>
      rows.map((item) => idSet.has(item.id) ? { ...item, status, updatedAt: now } : item)
    );
    return { updated: ids.length, status };
  }

  // ---------- 配置文件 ----------

  async listConfigs() {
    await this.ensureDefaultConfigs();
    const names = await readdir(this.configRoot);
    const items = [];
    for (const name of names) {
      const filePath = path.join(this.configRoot, name);
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        items.push({
          name,
          path: `data/configs/${name}`,
          size: fileStat.size,
          updatedAt: fileStat.mtime.toISOString()
        });
      }
    }
    return { items: items.toSorted((a, b) => a.name.localeCompare(b.name)) };
  }

  async getConfig(name) {
    const safeName = sanitizeFileName(name);
    await this.ensureDefaultConfigs();
    const filePath = path.join(this.configRoot, safeName);
    assertInside(this.configRoot, filePath);
    const content = await readFile(filePath, 'utf8');
    return { name: safeName, content };
  }

  async saveConfig(input) {
    const safeName = sanitizeFileName(input?.name);
    if (!safeName) throw new AppError('INVALID_CONFIG_NAME', '配置文件名不能为空');
    const filePath = path.join(this.configRoot, safeName);
    assertInside(this.configRoot, filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, String(input.content ?? ''), 'utf8');
    return { name: safeName };
  }

  async ensureDefaultConfigs() {
    await mkdir(this.configRoot, { recursive: true });
    for (const [name, content] of Object.entries(DEFAULT_CONFIGS)) {
      const filePath = path.join(this.configRoot, name);
      try {
        await access(filePath, constants.R_OK);
      } catch {
        await writeFile(filePath, content, 'utf8');
      }
    }
  }

  // ---------- 脚本 ----------

  async listScripts() {
    await mkdir(this.scriptRoot, { recursive: true });
    const items = await listFilesRecursive(this.scriptRoot, this.scriptRoot);
    return { items };
  }

  async getScript(relativePath) {
    const filePath = path.join(this.scriptRoot, normalizeScriptRelative(relativePath));
    assertInside(this.scriptRoot, filePath);
    const content = await readFile(filePath, 'utf8');
    return {
      path: toDataScriptPath(this.scriptRoot, filePath),
      content
    };
  }

  async saveScript(input) {
    const relativePath = normalizeScriptRelative(input?.path || `${Date.now()}-${sanitizeFileName(input?.name || 'script')}.js`);
    const filePath = path.join(this.scriptRoot, relativePath);
    assertInside(this.scriptRoot, filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, String(input.content ?? ''), 'utf8');
    return { path: toDataScriptPath(this.scriptRoot, filePath) };
  }

  async deleteScripts(paths = []) {
    for (const item of paths) {
      const relativePath = normalizeScriptRelative(item);
      if (!relativePath) throw new AppError('INVALID_SCRIPT_PATH', '不能删除 data/scripts 根目录');
      const filePath = path.join(this.scriptRoot, relativePath);
      assertInside(this.scriptRoot, filePath);
      await rm(filePath, { recursive: true, force: true });
    }
    await pruneEmptyDirectories(this.scriptRoot);
    return { deleted: paths.length };
  }

  // ---------- 订阅 ----------

  async listSubscriptions() {
    const rows = await this.subscriptionStore.read();
    return { items: rows };
  }

  async saveSubscription(input) {
    if (!input?.name?.trim()) throw new AppError('INVALID_SUBSCRIPTION_NAME', '订阅名称不能为空');
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    let saved;
    await this.subscriptionStore.update((rows) => {
      const index = rows.findIndex((item) => item.id === id);
      const existing = index >= 0 ? rows[index] : {};
      const source = parseSubscriptionSource({ ...existing, ...input });
      const subscriptionFolder = createSubscriptionFolder(input.name, id, source);
      const next = {
        ...existing,
        id,
        name: input.name.trim(),
        url: String(input.url ?? ''),
        branch: String(input.branch ?? ''),
        schedule: String(input.schedule ?? ''),
        status: input.status === 'disabled' ? 'disabled' : 'enabled',
        autoCreateTasks: input.autoCreateTasks === undefined ? Boolean(existing.autoCreateTasks) : Boolean(input.autoCreateTasks),
        subscriptionFolder,
        lastPulledAt: input.lastPulledAt || existing.lastPulledAt,
        lastResult: existing.lastResult,
        lastFiles: existing.lastFiles || [],
        localPath: `data/scripts/${subscriptionFolder}`,
        repoPath: getSubscriptionSourceCachePath(source, subscriptionFolder),
        createdAt: existing.createdAt || input.createdAt || now,
        updatedAt: now
      };
      if (index >= 0) rows[index] = next;
      else rows.push(next);
      saved = next;
      return rows;
    });
    return saved;
  }

  async deleteSubscriptions(ids = []) {
    const idSet = new Set(ids);
    const rows = await this.subscriptionStore.read();
    for (const row of rows.filter((item) => idSet.has(item.id))) {
      if (!row.subscriptionFolder) continue;
      const subscriptionFolder = sanitizePathPart(row.subscriptionFolder);
      const scriptFolderPath = path.join(this.scriptRoot, subscriptionFolder);
      const repoFolderPath = path.join(this.repoRoot, subscriptionFolder);
      const rawFilePath = path.join(this.rawRoot, `${subscriptionFolder}.js`);
      assertInside(this.scriptRoot, scriptFolderPath);
      assertInside(this.repoRoot, repoFolderPath);
      assertInside(this.rawRoot, rawFilePath);
      await rm(scriptFolderPath, { recursive: true, force: true });
      await rm(repoFolderPath, { recursive: true, force: true });
      await rm(rawFilePath, { force: true });
    }
    await this.subscriptionStore.update((latestRows) => latestRows.filter((item) => !idSet.has(item.id)));
    return { deleted: ids.length };
  }

  // 串行合并订阅字段，避免长时间拉取后用旧快照覆盖其他并发修改。
  async patchSubscription(id, patch) {
    let updated;
    await this.subscriptionStore.update((rows) => {
      const index = rows.findIndex((item) => item.id === id);
      if (index < 0) return rows;
      rows[index] = { ...rows[index], ...patch, updatedAt: new Date().toISOString() };
      updated = rows[index];
      return rows;
    });
    return updated;
  }

  async runSubscription(id, options = {}) {
    const rows = await this.subscriptionStore.read();
    const subscription = rows.find((item) => item.id === id);
    if (!subscription) throw new AppError('SUBSCRIPTION_NOT_FOUND', `订阅不存在: ${id}`);

    if (!this.runRepository) {
      return this.pullAndSaveSubscription(subscription);
    }

    const { run } = createSubscriptionRun(this.paths, subscription);
    await this.runRepository.save(run);
    const updated = await this.patchSubscription(id, {
      lastPulledAt: new Date().toISOString(),
      lastResult: '运行中，日志正在生成',
      lastError: undefined,
      lastRunId: run.id
    });

    const executeRun = () => this.executeSubscriptionRun(id, run.id);
    const shouldRunInBackground = options.background === true || options.waitForCompletion === false;
    if (shouldRunInBackground) {
      executeRun().catch((error) => {
        console.error(`订阅后台运行失败: ${subscription.name}`, error);
      });
      return { ...updated, runId: run.id, started: true };
    }

    const result = await executeRun();
    return { ...result, runId: run.id, started: false };
  }

  async pullAndSaveSubscription(subscription, context = {}) {
    try {
      const result = await pullSubscriptionFiles({
        subscription,
        scriptRoot: this.scriptRoot,
        repoRoot: this.repoRoot,
        rawRoot: this.rawRoot,
        log: context.log
      });
      const autoCreateTasks = subscription.autoCreateTasks
        ? await this.createTasksFromSubscription(subscription, result, context.log)
        : undefined;
      const autoCreateSummary = formatAutoCreateTaskSummary(autoCreateTasks);
      return await this.patchSubscription(subscription.id, {
        subscriptionFolder: result.subscriptionFolder,
        localPath: result.localPath,
        repoPath: result.repoPath,
        lastPulledAt: new Date().toISOString(),
        lastResult: `已拉取 ${result.files.length} 个文件到 ${result.localPath}${autoCreateSummary ? `，${autoCreateSummary}` : ''}`,
        lastFiles: result.files,
        lastError: undefined,
        lastRunId: context.runId || subscription.lastRunId,
        lastAutoCreateTasks: autoCreateTasks,
        sourceType: result.sourceType
      });
    } catch (error) {
      const message = error instanceof AppError ? error.message : String(error?.message || error);
      await this.patchSubscription(subscription.id, {
        lastPulledAt: new Date().toISOString(),
        lastResult: `拉取失败: ${message}`,
        lastError: message,
        lastRunId: context.runId || subscription.lastRunId
      });
      throw error;
    }
  }

  // 只基于脚本内明确可解析的 cron 声明自动建任务，不猜测。
  async createTasksFromSubscription(subscription, pullResult, log = async () => {}) {
    const summary = {
      enabled: true,
      created: 0,
      skippedExisting: 0,
      skippedNoCron: 0,
      skippedInvalidCron: 0,
      items: []
    };
    if (!this.taskRepository) {
      await log('自动创建任务：任务仓库未初始化，已跳过');
      return { ...summary, skippedReason: '任务仓库未初始化' };
    }

    const existingTasks = await this.taskRepository.list();
    const existingScriptPaths = new Set(existingTasks.map((task) => task.scriptPath));
    for (const scriptPath of pullResult.files || []) {
      if (existingScriptPaths.has(scriptPath)) {
        summary.skippedExisting += 1;
        summary.items.push({ scriptPath, status: 'skipped-existing' });
        continue;
      }

      let content = '';
      try {
        content = await readFile(resolvePortablePath(this.paths, scriptPath, { label: '订阅脚本路径' }), 'utf8');
      } catch (error) {
        summary.skippedInvalidCron += 1;
        summary.items.push({ scriptPath, status: 'read-failed', message: error.message });
        continue;
      }

      const cronInfo = extractScriptCron(content);
      if (!cronInfo) {
        summary.skippedNoCron += 1;
        summary.items.push({ scriptPath, status: 'skipped-no-cron' });
        continue;
      }

      try {
        assertValidCronExpression(cronInfo.cron);
      } catch (error) {
        summary.skippedInvalidCron += 1;
        summary.items.push({ scriptPath, status: 'skipped-invalid-cron', cron: cronInfo.rawCron || cronInfo.cron, message: error.message });
        continue;
      }

      const task = Task.create({
        name: cronInfo.name || createTaskNameFromScriptPath(scriptPath),
        scriptPath,
        cwd: pullResult.localPath,
        cronExpression: cronInfo.cron,
        labels: ['订阅', subscription.name].filter(Boolean),
        remark: `订阅「${subscription.name}」自动创建`,
        enabled: true,
        timeoutMs: 30000
      });
      await this.taskRepository.save(task);
      existingScriptPaths.add(scriptPath);
      summary.created += 1;
      summary.items.push({ scriptPath, status: 'created', taskId: task.id, cron: cronInfo.cron });
      await log(`自动创建任务：${task.name}，cron=${cronInfo.cron}`);
    }

    await log(`自动创建任务完成：新建 ${summary.created}，已存在 ${summary.skippedExisting}，无 cron ${summary.skippedNoCron}，无效 ${summary.skippedInvalidCron}`);
    return summary;
  }

  async executeSubscriptionRun(subscriptionId, runId) {
    const run = await this.runRepository.findById(runId);
    if (!run) throw new AppError('RUN_NOT_FOUND', `运行记录不存在: ${runId}`);

    const stdoutPath = resolvePortablePath(this.paths, run.stdoutPath, { label: '标准输出日志路径' });
    const stderrPath = resolvePortablePath(this.paths, run.stderrPath, { label: '错误日志路径' });
    const log = (message) => appendSubscriptionLog(stdoutPath, message);

    const rows = await this.subscriptionStore.read();
    const subscription = rows.find((item) => item.id === subscriptionId);
    if (!subscription) {
      const error = new AppError('SUBSCRIPTION_NOT_FOUND', `订阅不存在: ${subscriptionId}`);
      await appendSubscriptionLog(stderrPath, error.message);
      markRunFailed(run, error);
      await this.runRepository.save(run);
      throw error;
    }

    try {
      await log(`开始运行订阅：${subscription.name}`);
      await log(`订阅地址：${subscription.url || '-'}`);
      const result = await this.pullAndSaveSubscription(subscription, { runId, log });
      await log(`订阅运行成功：已拉取 ${result.lastFiles?.length || 0} 个文件到 ${result.localPath}`);
      markRunSucceeded(run);
      await this.runRepository.save(run);
      return result;
    } catch (error) {
      const message = error instanceof AppError ? error.message : String(error?.message || error);
      await appendSubscriptionLog(stderrPath, error.stack || message);
      markRunFailed(run, error);
      await this.runRepository.save(run);
      throw error;
    }
  }

  // ---------- 依赖 ----------

  async listDependencies() {
    const packageJsonPath = path.join(this.paths.dataRoot, 'package.json');
    const pkg = await readJsonOptional(packageJsonPath, { dependencies: {} });
    const history = await this.dependencyHistoryStore.read();
    return {
      items: Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version })),
      history
    };
  }

  async installDependency(name) {
    return this.runDependencyAction('install', name);
  }

  async removeDependency(name) {
    return this.runDependencyAction('remove', name);
  }

  async runDependencyAction(action, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new AppError('INVALID_DEPENDENCY_NAME', '依赖名称不能为空');
    const runtime = await resolveNodeRuntime(this.paths);
    const npmCommand = action === 'install' ? 'install' : 'uninstall';
    await runNpmCommand(runtime.nodePath, [
      npmCommand, trimmed,
      '--prefix', this.paths.dataRoot,
      '--cache', path.join(this.paths.cacheRoot, 'npm'),
      '--no-audit', '--no-fund', '--save-prod'
    ], this.paths);
    await this.dependencyHistoryStore.update((rows) => {
      rows.unshift({ id: randomUUID(), action, name: trimmed, status: 'success', createdAt: new Date().toISOString() });
      return rows.slice(0, 100);
    });
    return this.listDependencies();
  }
}

async function listFilesRecursive(root, current) {
  const entries = await readdir(current, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(root, fullPath);
    }
    if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      return [{
        name: entry.name,
        path: toDataScriptPath(root, fullPath),
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString()
      }];
    }
    return [];
  }));
  return groups.flat().toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function createSubscriptionRun(paths, subscription) {
  const run = Run.start({
    taskId: `subscription:${subscription.id}`,
    name: `订阅：${subscription.name || subscription.id}`,
    scriptPath: subscription.localPath || `data/scripts/${subscription.subscriptionFolder || sanitizePathPart(subscription.name) || 'subscription'}`,
    trigger: 'subscription',
    runtime: {
      type: 'subscription',
      name: 'ScriptPilot 订阅拉取'
    },
    dependencyCheck: {
      status: '订阅拉取无需脚本依赖预检',
      reason: '订阅运行只负责下载和导入脚本文件'
    },
    stdoutPath: '',
    stderrPath: ''
  });
  const logDir = path.join(paths.taskLogsRoot, 'subscriptions', sanitizePathPart(subscription.id));
  run.stdoutPath = toPortablePath(paths, path.join(logDir, `${run.id}.stdout.log`), { label: '标准输出日志路径' });
  run.stderrPath = toPortablePath(paths, path.join(logDir, `${run.id}.stderr.log`), { label: '错误日志路径' });
  return { run };
}

async function appendSubscriptionLog(filePath, message) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`, 'utf8');
}

function markRunSucceeded(run) {
  const endedAt = new Date().toISOString();
  run.status = 'success';
  run.endedAt = endedAt;
  run.durationMs = new Date(endedAt).getTime() - new Date(run.startedAt).getTime();
  run.exitCode = 0;
  run.signal = undefined;
  run.errorMessage = undefined;
}

function markRunFailed(run, error) {
  run.markFailed(error instanceof Error ? error : new Error(String(error)));
  run.exitCode = 1;
}

function formatAutoCreateTaskSummary(summary) {
  if (!summary?.enabled) return '';
  const parts = [];
  if (summary.created) parts.push(`自动创建 ${summary.created} 个任务`);
  if (summary.skippedExisting) parts.push(`跳过已存在 ${summary.skippedExisting} 个`);
  if (summary.skippedNoCron) parts.push(`无 cron ${summary.skippedNoCron} 个`);
  if (summary.skippedInvalidCron) parts.push(`无效 cron ${summary.skippedInvalidCron} 个`);
  return parts.join('，');
}

async function readJsonOptional(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function runNpmCommand(nodePath, npmArgs, paths) {
  const npmCliPath = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    await access(npmCliPath, constants.R_OK);
  } catch {
    throw new AppError('NPM_NOT_FOUND', '内置 npm 不存在，无法安装依赖', { npmCliPath });
  }

  await mkdir(path.join(paths.cacheRoot, 'npm'), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [npmCliPath, ...npmArgs], {
      cwd: paths.dataRoot,
      windowsHide: true,
      env: createPortableProcessEnv(paths)
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(new AppError('DEPENDENCY_COMMAND_SPAWN_FAILED', `依赖命令启动失败: ${error.message}`, {
        nodePath,
        npmCliPath,
        args: npmArgs,
        code: error.code
      }));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new AppError('DEPENDENCY_COMMAND_FAILED', stderr || stdout || `依赖命令失败，退出码 ${code}`, {
        nodePath,
        npmCliPath,
        args: npmArgs,
        exitCode: code,
        stdout,
        stderr
      }));
    });
  });
}

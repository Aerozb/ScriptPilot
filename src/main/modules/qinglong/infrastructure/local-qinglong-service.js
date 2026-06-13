import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { JsonStore } from '../../../shared/infrastructure/filesystem/json-store.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { createPortableProcessEnv, resolvePortablePath, toPortablePath } from '../../../bootstrap/portable-paths.js';
import { resolveNodeRuntime } from '../../runtime/infrastructure/node-runtime-resolver.js';
import { resolveGitRuntime } from '../../runtime/infrastructure/git-runtime-resolver.js';
import { Run } from '../../runs/domain/run.aggregate.js';
import { Task } from '../../tasks/domain/task.aggregate.js';
import { assertValidCronExpression } from '../../scheduler/infrastructure/cron-expression.js';

const DEFAULT_CONFIGS = {
  'config.sh': '# ScriptPilot 本地青龙版配置\nexport QL_DIR=\"$PWD\"\n',
  'notify.js': 'module.exports = async function notify(title, content) {\n  console.log(`[notify] ${title}: ${content}`);\n};\n',
  'extra.sh': '# 自定义 Shell 配置\n',
  'package.json': '{\n  "dependencies": {}\n}\n'
};
const DEFAULT_SCRIPT_SUPPORT_FILES = {
  'sendNotify.js': `async function sendNotify(title, content) {\n  console.log(\`[sendNotify] \${title}: \${content}\`);\n}\n\nmodule.exports = { sendNotify };\n`
};
const SCRIPT_SUBSCRIPTION_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SUBSCRIPTION_SUPPORT_FILES = new Set(['package.json']);
const MAX_REPOSITORY_FILES = 5000;
const MAX_SUBSCRIPTION_FILE_BYTES = 5 * 1024 * 1024;
const GITHUB_ACCELERATOR_BASE_URL = 'https://ghfast.top/';

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

  async listEnvs() {
    const rows = await this.envStore.read();
    return { items: rows.toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()) };
  }

  async saveEnv(input) {
    if (!input?.name?.trim()) throw new AppError('INVALID_ENV_NAME', '变量名称不能为空');
    const rows = await this.envStore.read();
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
    const index = rows.findIndex((item) => item.id === id);
    if (index >= 0) rows[index] = { ...rows[index], ...next, createdAt: rows[index].createdAt };
    else rows.push(next);
    await this.envStore.write(rows);
    return next;
  }

  async deleteEnvs(ids = []) {
    const idSet = new Set(ids);
    const rows = await this.envStore.read();
    await this.envStore.write(rows.filter((item) => !idSet.has(item.id)));
    return { deleted: ids.length };
  }

  async setEnvStatus(ids = [], status) {
    const idSet = new Set(ids);
    const rows = await this.envStore.read();
    const now = new Date().toISOString();
    const nextRows = rows.map((item) => idSet.has(item.id) ? { ...item, status, updatedAt: now } : item);
    await this.envStore.write(nextRows);
    return { updated: ids.length, status };
  }

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
    await assertInside(this.configRoot, filePath);
    const content = await readFile(filePath, 'utf8');
    return { name: safeName, content };
  }

  async saveConfig(input) {
    const safeName = sanitizeFileName(input?.name);
    if (!safeName) throw new AppError('INVALID_CONFIG_NAME', '配置文件名不能为空');
    const filePath = path.join(this.configRoot, safeName);
    await assertInside(this.configRoot, filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, String(input.content ?? ''), 'utf8');
    return { name: safeName };
  }

  async listScripts() {
    await mkdir(this.scriptRoot, { recursive: true });
    const items = await listFilesRecursive(this.scriptRoot, this.scriptRoot);
    return { items };
  }

  async getScript(relativePath) {
    const filePath = path.join(this.scriptRoot, normalizeRelative(relativePath));
    await assertInside(this.scriptRoot, filePath);
    const content = await readFile(filePath, 'utf8');
    return {
      path: toDataScriptPath(this.scriptRoot, filePath),
      content
    };
  }

  async saveScript(input) {
    const relativePath = normalizeRelative(input?.path || `${Date.now()}-${sanitizeFileName(input?.name || 'script')}.js`);
    const filePath = path.join(this.scriptRoot, relativePath);
    await assertInside(this.scriptRoot, filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, String(input.content ?? ''), 'utf8');
    return { path: toDataScriptPath(this.scriptRoot, filePath) };
  }

  async deleteScripts(paths = []) {
    for (const item of paths) {
      const relativePath = normalizeRelative(stripScriptPrefix(item));
      if (!relativePath) throw new AppError('INVALID_SCRIPT_PATH', '不能删除 data/scripts 根目录');
      const filePath = path.join(this.scriptRoot, relativePath);
      await assertInside(this.scriptRoot, filePath);
      await rm(filePath, { recursive: true, force: true });
    }
    await pruneEmptyDirectories(this.scriptRoot);
    return { deleted: paths.length };
  }

  async listSubscriptions() {
    const rows = await this.subscriptionStore.read();
    return { items: rows };
  }

  async saveSubscription(input) {
    if (!input?.name?.trim()) throw new AppError('INVALID_SUBSCRIPTION_NAME', '订阅名称不能为空');
    const rows = await this.subscriptionStore.read();
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    const index = rows.findIndex((item) => item.id === id);
    const existing = index >= 0 ? rows[index] : {};
    const source = parseSubscriptionSource({
      ...existing,
      ...input
    });
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
    if (index >= 0) rows[index] = { ...rows[index], ...next, createdAt: rows[index].createdAt };
    else rows.push(next);
    await this.subscriptionStore.write(rows);
    return next;
  }

  async deleteSubscriptions(ids = []) {
    const idSet = new Set(ids);
    const rows = await this.subscriptionStore.read();
    const rowsToDelete = rows.filter((item) => idSet.has(item.id));
    for (const row of rowsToDelete) {
      if (!row.subscriptionFolder) continue;
      const subscriptionFolder = sanitizePathPart(row.subscriptionFolder);
      const scriptFolderPath = path.join(this.scriptRoot, subscriptionFolder);
      const repoFolderPath = path.join(this.repoRoot, subscriptionFolder);
      const rawFilePath = path.join(this.rawRoot, `${subscriptionFolder}.js`);
      await assertInside(this.scriptRoot, scriptFolderPath);
      await assertInside(this.repoRoot, repoFolderPath);
      await assertInside(this.rawRoot, rawFilePath);
      await rm(scriptFolderPath, { recursive: true, force: true });
      await rm(repoFolderPath, { recursive: true, force: true });
      await rm(rawFilePath, { force: true });
    }
    await this.subscriptionStore.write(rows.filter((item) => !idSet.has(item.id)));
    return { deleted: ids.length };
  }

  async runSubscription(id, options = {}) {
    const rows = await this.subscriptionStore.read();
    const index = rows.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError('SUBSCRIPTION_NOT_FOUND', `订阅不存在: ${id}`);

    if (!this.runRepository) {
      return this.pullAndSaveSubscription(rows, index);
    }

    const { run } = createSubscriptionRun(this.paths, rows[index]);
    const now = new Date().toISOString();
    rows[index] = {
      ...rows[index],
      lastPulledAt: now,
      lastResult: '运行中，日志正在生成',
      lastError: undefined,
      lastRunId: run.id,
      updatedAt: now
    };
    await this.runRepository.save(run);
    await this.subscriptionStore.write(rows);

    const executeRun = () => this.executeSubscriptionRun(rows[index].id, run.id);
    const shouldRunInBackground = options.background === true || options.waitForCompletion === false;
    if (shouldRunInBackground) {
      executeRun().catch((error) => {
        console.error(`订阅后台运行失败: ${rows[index].name}`, error);
      });
      return { ...rows[index], runId: run.id, started: true };
    }

    const result = await executeRun();
    return { ...result, runId: run.id, started: false };
  }

  async pullAndSaveSubscription(rows, index, context = {}) {
    const logRows = [];
    const baseLog = typeof context.log === 'function' ? context.log : async () => {};
    const log = async (message) => {
      const text = String(message ?? '');
      logRows.push(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${text}`);
      await baseLog(text);
    };

    try {
      const result = await pullSubscriptionFiles({
        subscription: rows[index],
        paths: this.paths,
        scriptRoot: this.scriptRoot,
        repoRoot: this.repoRoot,
        rawRoot: this.rawRoot,
        log
      });
      const autoCreateTasks = rows[index].autoCreateTasks
        ? await this.createTasksFromSubscription(rows[index], result, log)
        : undefined;
      const autoCreateSummary = formatAutoCreateTaskSummary(autoCreateTasks);
      rows[index] = {
        ...rows[index],
        subscriptionFolder: result.subscriptionFolder,
        localPath: result.localPath,
        repoPath: result.repoPath,
        lastPulledAt: new Date().toISOString(),
        lastResult: `已拉取 ${result.files.length} 个文件到 ${result.localPath}${autoCreateSummary ? `，${autoCreateSummary}` : ''}`,
        lastLog: logRows.join('\n'),
        lastFiles: result.files,
        lastError: undefined,
        lastRunId: context.runId || rows[index].lastRunId,
        lastAutoCreateTasks: autoCreateTasks,
        sourceType: result.sourceType,
        updatedAt: new Date().toISOString()
      };
      await this.subscriptionStore.write(rows);
      return rows[index];
    } catch (error) {
      const message = error instanceof AppError ? error.message : String(error?.message || error);
      rows[index] = {
        ...rows[index],
        lastPulledAt: new Date().toISOString(),
        lastResult: `拉取失败: ${message}`,
        lastLog: logRows.join('\n'),
        lastError: message,
        lastRunId: context.runId || rows[index].lastRunId,
        updatedAt: new Date().toISOString()
      };
      await this.subscriptionStore.write(rows);
      throw error;
    }
  }

  async createTasksFromSubscription(subscription, pullResult, log = async () => {}) {
    const summary = {
      enabled: true,
      created: 0,
      updatedExisting: 0,
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
    const existingTasksByScriptPath = new Map(existingTasks.map((task) => [task.scriptPath, task]));
    const usedTaskNames = new Set(existingTasks.map((task) => task.name));
    for (const scriptPath of pullResult.files || []) {
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

      const taskName = cronInfo.name || createTaskNameFromScriptPath(scriptPath);
      const existingTask = existingTasksByScriptPath.get(scriptPath);
      if (existingTask) {
        const updated = await this.refreshExistingSubscriptionTask({
          task: existingTask,
          subscription,
          pullResult,
          scriptPath,
          cronInfo,
          taskName,
          usedTaskNames,
          log
        });
        if (updated) {
          summary.updatedExisting += 1;
          summary.items.push({ scriptPath, status: 'updated-existing', taskId: existingTask.id, cron: cronInfo.cron, name: existingTask.name });
        } else {
          summary.skippedExisting += 1;
          summary.items.push({ scriptPath, status: 'skipped-existing', taskId: existingTask.id });
        }
        continue;
      }

      const task = Task.create({
        name: createUniqueTaskName(taskName, usedTaskNames),
        scriptPath,
        cwd: pullResult.localPath,
        cronExpression: cronInfo.cron,
        labels: ['订阅', subscription.name].filter(Boolean),
        remark: `订阅「${subscription.name}」自动创建`,
        enabled: true,
        timeoutMs: 30000
      });
      await this.taskRepository.save(task);
      existingTasksByScriptPath.set(scriptPath, task);
      usedTaskNames.add(task.name);
      summary.created += 1;
      summary.items.push({ scriptPath, status: 'created', taskId: task.id, cron: cronInfo.cron, name: task.name });
      await log(`自动创建任务：${task.name}，cron=${cronInfo.cron}`);
    }

    await log(`自动创建任务完成：新建 ${summary.created}，更新 ${summary.updatedExisting}，已存在 ${summary.skippedExisting}，无 cron ${summary.skippedNoCron}，无效 ${summary.skippedInvalidCron}`);
    return summary;
  }

  async refreshExistingSubscriptionTask(input) {
    const { task, subscription, pullResult, cronInfo, taskName, usedTaskNames, log } = input;
    if (!isSubscriptionManagedTask(task, subscription)) return false;

    const nextName = createUniqueTaskName(taskName, usedTaskNames, task.name);
    const nextLabels = mergeTaskLabels(task.labels, ['订阅', subscription.name]);
    const nextRemark = `订阅「${subscription.name}」自动创建`;
    const changed =
      task.name !== nextName ||
      task.cronExpression !== cronInfo.cron ||
      task.cwd !== pullResult.localPath ||
      task.remark !== nextRemark ||
      !sameStringArray(task.labels, nextLabels);

    if (!changed) return false;

    const previousName = task.name;
    task.refreshSubscriptionMetadata({
      name: nextName,
      cronExpression: cronInfo.cron,
      cwd: pullResult.localPath,
      labels: nextLabels,
      remark: nextRemark
    });
    await this.taskRepository.save(task);
    usedTaskNames.delete(previousName);
    usedTaskNames.add(task.name);
    await log(`自动更新任务：${previousName} -> ${task.name}，cron=${cronInfo.cron}`);
    return true;
  }

  async executeSubscriptionRun(subscriptionId, runId) {
    const run = await this.runRepository.findById(runId);
    if (!run) throw new AppError('RUN_NOT_FOUND', `运行记录不存在: ${runId}`);

    const stdoutPath = resolvePortablePath(this.paths, run.stdoutPath, { label: '标准输出日志路径' });
    const stderrPath = resolvePortablePath(this.paths, run.stderrPath, { label: '错误日志路径' });
    const log = (message) => appendSubscriptionLog(stdoutPath, message);

    const rows = await this.subscriptionStore.read();
    const index = rows.findIndex((item) => item.id === subscriptionId);
    if (index < 0) {
      const error = new AppError('SUBSCRIPTION_NOT_FOUND', `订阅不存在: ${subscriptionId}`);
      await appendSubscriptionLog(stderrPath, error.message);
      markRunFailed(run, error);
      await this.runRepository.save(run);
      throw error;
    }

    try {
      await log(`开始运行订阅：${rows[index].name}`);
      await log(`订阅地址：${rows[index].url || '-'}`);
      const result = await this.pullAndSaveSubscription(rows, index, { runId, log });
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
    if (!name || !String(name).trim()) throw new AppError('INVALID_DEPENDENCY_NAME', '依赖名称不能为空');
    const runtime = await resolveNodeRuntime(this.paths);
    await runNpmCommand(runtime.nodePath, ['install', String(name).trim(), '--prefix', this.paths.dataRoot, '--cache', path.join(this.paths.cacheRoot, 'npm'), '--no-audit', '--no-fund', '--save-prod'], this.paths);
    await this.appendDependencyHistory({ action: 'install', name: String(name).trim(), status: 'success' });
    return this.listDependencies();
  }

  async removeDependency(name) {
    if (!name || !String(name).trim()) throw new AppError('INVALID_DEPENDENCY_NAME', '依赖名称不能为空');
    const runtime = await resolveNodeRuntime(this.paths);
    await runNpmCommand(runtime.nodePath, ['uninstall', String(name).trim(), '--prefix', this.paths.dataRoot, '--cache', path.join(this.paths.cacheRoot, 'npm'), '--no-audit', '--no-fund', '--save-prod'], this.paths);
    await this.appendDependencyHistory({ action: 'remove', name: String(name).trim(), status: 'success' });
    return this.listDependencies();
  }

  async appendDependencyHistory(record) {
    const rows = await this.dependencyHistoryStore.read();
    rows.unshift({ id: randomUUID(), ...record, createdAt: new Date().toISOString() });
    await this.dependencyHistoryStore.write(rows.slice(0, 100));
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

  async ensureScriptSupportFiles() {
    await mkdir(this.scriptRoot, { recursive: true });
    for (const [name, content] of Object.entries(DEFAULT_SCRIPT_SUPPORT_FILES)) {
      const filePath = path.join(this.scriptRoot, name);
      try {
        await access(filePath, constants.R_OK);
      } catch {
        await writeFile(filePath, content, 'utf8');
      }
    }
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
  const items = groups.flat();
  return items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function pullSubscriptionFiles(input) {
  if (!input.subscription?.url?.trim()) {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址不能为空');
  }

  const log = createSubscriptionLogger(input.log);
  const source = parseSubscriptionSource(input.subscription);
  const subscriptionFolder = createSubscriptionFolder(input.subscription.name, input.subscription.id, source);
  const previousFolder = input.subscription.subscriptionFolder ? sanitizePathPart(input.subscription.subscriptionFolder) : '';
  const repoRoot = input.repoRoot || path.join(path.dirname(input.scriptRoot), 'repo');
  const rawRoot = input.rawRoot || path.join(path.dirname(input.scriptRoot), 'raw');
  const scriptTargetRoot = path.join(input.scriptRoot, sanitizePathPart(subscriptionFolder));
  const repoTargetRoot = path.join(repoRoot, sanitizePathPart(subscriptionFolder));
  const rawTargetPath = path.join(rawRoot, `${sanitizePathPart(subscriptionFolder)}.js`);
  await mkdir(repoRoot, { recursive: true });
  await mkdir(rawRoot, { recursive: true });
  await mkdir(input.scriptRoot, { recursive: true });
  await log(`解析订阅源：${describeSubscriptionSource(source)}`);
  await log(`目标脚本目录：data/scripts/${subscriptionFolder}`);
  for (const folder of new Set([previousFolder, sanitizePathPart(subscriptionFolder)].filter(Boolean))) {
    const scriptFolderPath = path.join(input.scriptRoot, folder);
    const repoFolderPath = path.join(repoRoot, folder);
    const rawFilePath = path.join(rawRoot, `${folder}.js`);
    await assertInside(input.scriptRoot, scriptFolderPath);
    await assertInside(repoRoot, repoFolderPath);
    await assertInside(rawRoot, rawFilePath);
    await log(`清理本地缓存和脚本目录：${folder}`);
    await rm(scriptFolderPath, { recursive: true, force: true });
    await rm(repoFolderPath, { recursive: true, force: true });
    await rm(rawFilePath, { force: true });
  }
  await mkdir(scriptTargetRoot, { recursive: true });

  const result = await downloadSubscriptionSource(source, {
    paths: input.paths,
    repoRoot: repoTargetRoot,
    rawRoot,
    rawFilePath: rawTargetPath,
    scriptRoot: scriptTargetRoot,
    subscriptionFolder
  }, log);
  const files = result.files;
  if (!files.length) {
    throw new AppError('SUBSCRIPTION_EMPTY', '订阅源没有找到可导入的 NodeJS 脚本文件');
  }

  await ensureSubscriptionSupportFiles(scriptTargetRoot);
  await log(`写入青龙兼容支持文件：sendNotify.js`);
  await log(`导入完成：${files.length} 个脚本文件`);

  return {
    subscriptionFolder,
    sourceType: source.type,
    localPath: `data/scripts/${subscriptionFolder}`,
    repoPath: result.repoPath,
    files: files.map((file) => `data/scripts/${subscriptionFolder}/${file}`.replaceAll('\\', '/'))
  };
}

function createSubscriptionLogger(log) {
  return typeof log === 'function' ? log : async () => {};
}

function parseSubscriptionInput(subscription) {
  const rawAddress = String(subscription.url || '').trim();
  const command = parseQinglongRepoCommand(rawAddress);
  return {
    address: command?.address || rawAddress,
    commandType: command?.commandType,
    branch: String(subscription.branch || command?.branch || '').trim(),
    filters: {
      includePattern: String(subscription.includePattern || command?.includePattern || '').trim(),
      excludePattern: String(subscription.excludePattern || command?.excludePattern || '').trim()
    }
  };
}

function parseQinglongRepoCommand(value) {
  const tokens = splitCommandLine(value);
  const commandIndex = tokens.findIndex((token) => ['repo', 'raw'].includes(token.toLowerCase()));
  if (commandIndex < 0) return undefined;

  const sourceIndex = tokens.findIndex((token, index) => index > commandIndex && looksLikeSubscriptionAddress(token));
  if (sourceIndex < 0) return undefined;

  const extras = tokens.slice(sourceIndex + 1);
  const commandType = tokens[commandIndex].toLowerCase();
  if (commandType === 'raw') {
    return {
      commandType,
      address: tokens[sourceIndex]
    };
  }

  return {
    commandType,
    address: tokens[sourceIndex],
    includePattern: extras[0] || '',
    excludePattern: extras[1] || '',
    dependencyPattern: extras[2] || '',
    branch: extras[3] || ''
  };
}

function splitCommandLine(value) {
  const tokens = [];
  let token = '';
  let quote = '';
  let hasToken = false;

  for (const char of String(value || '')) {
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      hasToken = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(token);
        token = '';
        hasToken = false;
      }
      continue;
    }

    token += char;
    hasToken = true;
  }

  if (hasToken) tokens.push(token);
  return tokens;
}

function looksLikeSubscriptionAddress(value) {
  const trimmed = String(value || '').trim();
  return /^https?:\/\//i.test(trimmed) ||
    /^git@github\.com:/i.test(trimmed) ||
    /^ssh:\/\/git@github\.com\//i.test(trimmed) ||
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/i.test(trimmed);
}

function parseGitHubShorthandSource(parsedInput, subscription) {
  const address = String(parsedInput.address || '').trim();
  const sshMatch = address.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i) ||
    address.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  const shortMatch = address.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i);
  const match = sshMatch || shortMatch;
  if (!match) return undefined;

  return {
    type: 'github-repo',
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
    branch: parsedInput.branch || String(subscription.branch || '').trim() || undefined,
    subPath: '',
    filters: parsedInput.filters
  };
}

function parseSubscriptionSource(subscription) {
  const parsedInput = parseSubscriptionInput(subscription);
  const shorthandSource = parseGitHubShorthandSource(parsedInput, subscription);
  if (shorthandSource) return shorthandSource;

  let parsed;
  try {
    parsed = new URL(parsedInput.address);
  } catch {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址必须是 http 或 https 地址');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址只支持 http 和 https');
  }

  if (parsedInput.commandType === 'raw') {
    return {
      type: 'http-file',
      url: parsed.toString(),
      fileName: path.posix.basename(decodeURIComponent(parsed.pathname)) || 'downloaded-script.js'
    };
  }

  if (parsed.hostname === 'raw.githubusercontent.com') {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 4) {
      throw new AppError('INVALID_GITHUB_RAW_URL', 'GitHub Raw 地址格式不正确');
    }
    return {
      type: 'github-raw-file',
      owner: segments[0],
      repo: segments[1],
      branch: segments[2],
      repoPath: segments.slice(3).join('/'),
      rawUrl: parsed.toString(),
      filters: parsedInput.filters
    };
  }

  if (parsed.hostname === 'github.com') {
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new AppError('INVALID_GITHUB_URL', 'GitHub 地址需要包含 owner/repo');
    }

    const branch = String(subscription.branch || parsedInput.branch || '').trim();
    if (segments[2] === 'blob' || segments[2] === 'raw') {
      if (segments.length < 5) throw new AppError('INVALID_GITHUB_FILE_URL', 'GitHub 文件地址格式不正确');
      return {
        type: 'github-file',
        owner: segments[0],
        repo: segments[1],
        branch: branch || segments[3],
        repoPath: segments.slice(4).join('/'),
        filters: parsedInput.filters
      };
    }

    if (segments[2] === 'tree') {
      if (segments.length < 4) throw new AppError('INVALID_GITHUB_TREE_URL', 'GitHub 目录地址格式不正确');
      return {
        type: 'github-repo',
        owner: segments[0],
        repo: segments[1],
        branch: branch || segments[3],
        subPath: segments.slice(4).join('/'),
        filters: parsedInput.filters
      };
    }

    return {
      type: 'github-repo',
      owner: segments[0],
      repo: segments[1],
      branch: branch || parsedInput.branch || undefined,
      subPath: '',
      filters: parsedInput.filters
    };
  }

  return {
    type: 'http-file',
    url: parsed.toString(),
    fileName: path.posix.basename(decodeURIComponent(parsed.pathname)) || 'downloaded-script.js'
  };
}

async function downloadSubscriptionSource(source, targets, log = async () => {}) {
  if (source.type === 'github-repo') return downloadGitHubRepository(source, targets, log);
  if (source.type === 'github-file' || source.type === 'github-raw-file') return downloadGitHubFile(source, targets, log);
  if (source.type === 'http-file') return downloadHttpFile(source, targets, log);
  throw new AppError('UNSUPPORTED_SUBSCRIPTION_SOURCE', '不支持的订阅源类型');
}

async function downloadGitHubRepository(source, targets, log = async () => {}) {
  if (!targets.paths) {
    throw new AppError('PORTABLE_PATHS_REQUIRED', '仓库订阅缺少绿色目录上下文');
  }

  const prefix = normalizeRepoPath(source.subPath);
  const gitRuntime = await resolveGitRuntime(targets.paths);
  const cloneUrl = createGitHubCloneUrl(source);
  await log(`Git 运行时：${gitRuntime.version || 'unknown'}，${gitRuntime.source || 'unknown'}`);
  await log(`仓库地址：${cloneUrl}`);
  if (source.branch) await log(`指定分支：${source.branch}`);
  if (prefix) await log(`仓库子目录：${prefix}`);

  await syncGitRepositoryWithFallback({
    gitRuntime,
    paths: targets.paths,
    cloneUrl,
    branch: source.branch,
    targetRoot: targets.repoRoot,
    log
  });

  const sourceRoot = prefix ? path.join(targets.repoRoot, prefix) : targets.repoRoot;
  await assertInside(targets.repoRoot, sourceRoot);
  await assertDirectoryExists(sourceRoot, 'SUBSCRIPTION_SUBPATH_NOT_FOUND', `订阅仓库目录不存在: ${prefix || '/'}`);
  await log(`扫描仓库文件：${prefix || '/'}`);

  const repoEntries = await listPullableRepositoryFiles({
    sourceRoot,
    filters: source.filters
  });
  await log(`筛选到可导入文件：${repoEntries.length} 个`);

  const written = [];
  for (const entry of repoEntries) {
    await copySubscriptionScript({
      sourceRoot,
      targetRoot: targets.scriptRoot,
      relativePath: entry.path
    });
    written.push(normalizeRelativePath(entry.path));
    await log(`导入脚本：${normalizeRelativePath(entry.path)}`);
  }

  return {
    repoPath: `data/repo/${targets.subscriptionFolder}`,
    files: written
  };
}

async function downloadGitHubFile(source, targets, log = async () => {}) {
  const repoPath = normalizeRepoPath(source.repoPath);
  if (!pathShouldBePulled(repoPath, source.filters)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', '订阅文件只支持 .js、.mjs、.cjs 或 package.json');
  }
  const branch = source.branch || await resolveGitHubBranch(source);
  const rawUrl = source.rawUrl || createGitHubRawUrl(source.owner, source.repo, branch, repoPath);
  const relativePath = path.posix.basename(repoPath);
  await log(`下载 GitHub 文件：${source.owner}/${source.repo}/${repoPath}#${branch}`);
  await writeRemoteFile({
    url: rawUrl,
    fallbackUrl: createGitHubAcceleratedUrl(rawUrl),
    targetRoot: targets.repoRoot,
    relativePath,
    log
  });
  await copySubscriptionScript({
    sourceRoot: targets.repoRoot,
    targetRoot: targets.scriptRoot,
    relativePath
  });
  return {
    repoPath: `data/repo/${targets.subscriptionFolder}`,
    files: [relativePath]
  };
}

async function downloadHttpFile(source, targets, log = async () => {}) {
  const relativePath = sanitizePathPart(source.fileName);
  if (!pathShouldBePulled(relativePath)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', 'HTTP 订阅只支持 .js、.mjs、.cjs 或 package.json');
  }
  await log(`下载 HTTP 文件：${source.url}`);
  await writeRemoteFile({
    url: source.url,
    targetRoot: targets.rawRoot,
    relativePath: path.basename(targets.rawFilePath),
    log
  });
  await copySingleFile(targets.rawFilePath, path.join(targets.scriptRoot, relativePath), targets.scriptRoot);
  await log(`导入脚本：${relativePath}`);
  return {
    repoPath: `data/raw/${path.basename(targets.rawFilePath)}`,
    files: [relativePath]
  };
}

async function writeRemoteFile(input) {
  const safeRelativePath = normalizeRelativePath(input.relativePath);
  if (!safeRelativePath) return;

  const filePath = path.join(input.targetRoot, safeRelativePath);
  await assertInside(input.targetRoot, filePath);
  await input.log?.(`请求远程文件：${input.url}`);

  let content;
  try {
    content = await fetchText(input.url, `下载文件失败: ${safeRelativePath}`);
  } catch (error) {
    if (!input.fallbackUrl || input.fallbackUrl === input.url) throw error;
    await input.log?.(`直连下载失败，切换 ghfast 加速重试：${formatLogError(error)}`);
    await input.log?.(`请求 ghfast 加速文件：${input.fallbackUrl}`);
    content = await fetchText(input.fallbackUrl, `ghfast 加速下载文件失败: ${safeRelativePath}`);
  }

  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_SUBSCRIPTION_FILE_BYTES) {
    throw new AppError('SUBSCRIPTION_FILE_TOO_LARGE', `订阅文件过大: ${safeRelativePath}`);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  await input.log?.(`保存远程文件：${safeRelativePath}，${formatBytes(size)}`);
}

async function fetchJson(url, errorMessage) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ScriptPilot'
    }
  });

  if (!response.ok) {
    throw new AppError('REMOTE_REQUEST_FAILED', `${errorMessage}: HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchText(url, errorMessage) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'ScriptPilot'
    }
  });

  if (!response.ok) {
    throw new AppError('REMOTE_REQUEST_FAILED', `${errorMessage}: HTTP ${response.status}`);
  }

  return response.text();
}

async function resolveGitHubBranch(source) {
  if (source.branch) return source.branch;
  const repository = await fetchJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}`,
    '读取 GitHub 仓库信息失败'
  );
  return repository.default_branch || 'main';
}

function createGitHubRawUrl(owner, repo, branch, repoPath) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

function createGitHubCloneUrl(source) {
  return `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}.git`;
}

async function syncGitRepositoryWithFallback(input) {
  const attempts = [
    {
      name: 'GitHub 直连',
      cloneUrl: input.cloneUrl
    },
    {
      name: 'ghfast 加速',
      cloneUrl: createGitHubAcceleratedUrl(input.cloneUrl)
    }
  ].filter((attempt, index, rows) => attempt.cloneUrl && rows.findIndex((item) => item.cloneUrl === attempt.cloneUrl) === index);

  let lastError;
  for (const [index, attempt] of attempts.entries()) {
    if (index > 0) {
      await input.log?.(`GitHub 直连拉取失败，切换 ${attempt.name} 重试`);
      await rm(input.targetRoot, { recursive: true, force: true });
    }

    try {
      await input.log?.(`拉取方式：${attempt.name}`);
      await syncGitRepository({
        ...input,
        cloneUrl: attempt.cloneUrl
      });
      if (index > 0) await input.log?.(`${attempt.name} 拉取成功`);
      return;
    } catch (error) {
      lastError = error;
      await input.log?.(`${attempt.name} 拉取失败：${formatLogError(error)}`);
    }
  }

  throw lastError;
}

function createGitHubAcceleratedUrl(targetUrl) {
  const url = String(targetUrl || '').trim();
  if (!url || url.startsWith(GITHUB_ACCELERATOR_BASE_URL)) return url;
  if (!/^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\//i.test(url)) return url;
  return `${GITHUB_ACCELERATOR_BASE_URL}${url}`;
}

async function syncGitRepository(input) {
  await mkdir(path.dirname(input.targetRoot), { recursive: true });
  await assertInside(path.dirname(input.targetRoot), input.targetRoot);

  if (await isGitRepository(input.targetRoot)) {
    await input.log?.('检测到已有 Git 仓库，执行增量更新');
    try {
      await updateGitRepository(input);
      return;
    } catch (error) {
      await input.log?.(`增量更新失败，将删除缓存后重新克隆：${formatLogError(error)}`);
      await rm(input.targetRoot, { recursive: true, force: true });
    }
  } else {
    await input.log?.('未检测到本地仓库，执行首次克隆');
    await rm(input.targetRoot, { recursive: true, force: true });
  }

  await cloneGitRepository(input);
}

async function cloneGitRepository(input) {
  const args = ['clone', '--depth=1', '--single-branch'];
  if (input.branch) args.push('--branch', input.branch);
  args.push(input.cloneUrl, input.targetRoot);
  await runGitCommand({
    gitRuntime: input.gitRuntime,
    paths: input.paths,
    args,
    cwd: path.dirname(input.targetRoot),
    label: '克隆订阅仓库',
    log: input.log
  });
}

async function updateGitRepository(input) {
  await runGitCommand({
    gitRuntime: input.gitRuntime,
    paths: input.paths,
    args: ['remote', 'set-url', 'origin', input.cloneUrl],
    cwd: input.targetRoot,
    label: '更新订阅仓库地址',
    log: input.log
  });

  if (input.branch) {
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['fetch', '--depth=1', 'origin', input.branch],
      cwd: input.targetRoot,
      label: '拉取订阅仓库分支',
      log: input.log
    });
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['checkout', '-B', input.branch, 'FETCH_HEAD'],
      cwd: input.targetRoot,
      label: '切换订阅仓库分支',
      log: input.log
    });
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['reset', '--hard', 'FETCH_HEAD'],
      cwd: input.targetRoot,
      label: '重置订阅仓库',
      log: input.log
    });
  } else {
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['pull', '--ff-only', '--depth=1'],
      cwd: input.targetRoot,
      label: '更新订阅仓库',
      log: input.log
    });
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['reset', '--hard', 'HEAD'],
      cwd: input.targetRoot,
      label: '重置订阅仓库',
      log: input.log
    });
  }

  await runGitCommand({
    gitRuntime: input.gitRuntime,
    paths: input.paths,
    args: ['clean', '-ffd'],
    cwd: input.targetRoot,
    label: '清理订阅仓库',
    log: input.log
  });
}

async function isGitRepository(targetRoot) {
  try {
    await access(path.join(targetRoot, '.git'), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function runGitCommand(input) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    input.log?.(`${input.label}：${createGitCommandLine(input.gitRuntime.gitPath, input.args)}，cwd=${input.cwd}`);
    const child = spawn(input.gitRuntime.gitPath, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      env: createGitProcessEnv(input.paths, input.gitRuntime)
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
      reject(new AppError('GIT_COMMAND_FAILED', `${input.label}失败: ${error.message}`));
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      if (stdout.trim()) input.log?.(`Git stdout：${redactLogText(stdout.trim())}`);
      if (stderr.trim()) input.log?.(`Git stderr：${redactLogText(stderr.trim())}`);
      input.log?.(`${input.label}结束：exit=${code}，耗时 ${formatDuration(durationMs)}`);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new AppError('GIT_COMMAND_FAILED', `${input.label}失败: ${redactLogText(stderr || stdout || `exit ${code}`)}`));
    });
  });
}

function createGitCommandLine(gitPath, args = []) {
  return [gitPath, ...args].map(formatCommandPart).join(' ');
}

function formatCommandPart(value) {
  const text = String(value ?? '');
  if (!text || /[\s"]/u.test(text)) return `"${text.replaceAll('"', '\\"')}"`;
  return text;
}

function formatLogError(error) {
  return error instanceof AppError ? error.message : String(error?.message || error);
}

function redactLogText(value) {
  return String(value || '')
    .replace(/pt_key=[^;\s]+/gi, 'pt_key=***')
    .replace(/pt_pin=[^;\s]+/gi, 'pt_pin=***');
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return '-';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function createGitProcessEnv(paths, gitRuntime) {
  const gitRoot = gitRuntime.gitRoot;
  const env = createPortableProcessEnv(paths, {
    PATH: [
      path.dirname(gitRuntime.gitPath),
      gitRoot && path.join(gitRoot, 'cmd'),
      gitRoot && path.join(gitRoot, 'mingw64', 'bin'),
      gitRoot && path.join(gitRoot, 'usr', 'bin'),
      process.env.PATH || ''
    ].filter(Boolean).join(path.delimiter),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo'
  });
  env.HOME = path.join(paths.dataRoot, 'home');
  env.USERPROFILE = path.join(paths.dataRoot, 'home');
  return env;
}

async function assertDirectoryExists(directoryPath, code, message) {
  try {
    const fileStat = await stat(directoryPath);
    if (fileStat.isDirectory()) return;
  } catch {
    // Throw normalized app error below.
  }
  throw new AppError(code, message);
}

async function listPullableRepositoryFiles(input, current = input.sourceRoot, items = []) {
  if (items.length >= MAX_REPOSITORY_FILES) return items;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (items.length >= MAX_REPOSITORY_FILES) break;
    if (entry.name === '.git') continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await listPullableRepositoryFiles(input, fullPath, items);
    } else if (entry.isFile()) {
      const relativePath = normalizeRelativePath(path.relative(input.sourceRoot, fullPath));
      if (pathShouldBePulled(relativePath, input.filters)) {
        items.push({ path: relativePath });
      }
    }
  }
  return items;
}
function pathShouldBePulled(value, filters = {}) {
  const normalized = normalizeRelativePath(value);
  const basename = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(basename);
  const supported = SCRIPT_SUBSCRIPTION_EXTENSIONS.has(ext) || SUBSCRIPTION_SUPPORT_FILES.has(basename);
  if (!supported) return false;
  return passesSubscriptionFilters(normalized, filters);
}

function passesSubscriptionFilters(relativePath, filters = {}) {
  const includePattern = String(filters.includePattern || '').trim();
  const excludePattern = String(filters.excludePattern || '').trim();
  if (includePattern && !matchesSubscriptionPattern(includePattern, relativePath)) return false;
  if (excludePattern && matchesSubscriptionPattern(excludePattern, relativePath)) return false;
  return true;
}

function matchesSubscriptionPattern(pattern, relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized);
  const parts = String(pattern || '')
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts.length ? parts : [String(pattern || '').trim()]) {
    if (!part) continue;
    try {
      const regex = new RegExp(part, 'i');
      if (regex.test(normalized) || regex.test(basename)) return true;
    } catch {
      if (normalized.toLowerCase().includes(part.toLowerCase()) || basename.toLowerCase().includes(part.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

function normalizeRepoPath(value) {
  return normalizeRelativePath(value).replace(/\/+$/, '');
}

function normalizeRelativePath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .split('/')
    .map((part) => sanitizePathPart(part))
    .filter(Boolean)
    .join('/');
}

function getSubscriptionSourceCachePath(source, subscriptionFolder) {
  if (source?.type === 'http-file') return `data/raw/${subscriptionFolder}.js`;
  return `data/repo/${subscriptionFolder}`;
}

function createSubscriptionRun(paths, subscription) {
  const taskId = `subscription:${subscription.id}`;
  const scriptPath = subscription.localPath || `data/scripts/${subscription.subscriptionFolder || sanitizePathPart(subscription.name) || 'subscription'}`;
  const run = Run.start({
    taskId,
    name: `订阅：${subscription.name || subscription.id}`,
    scriptPath,
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
  const stdoutPath = path.join(logDir, `${run.id}.stdout.log`);
  const stderrPath = path.join(logDir, `${run.id}.stderr.log`);
  run.stdoutPath = toPortablePath(paths, stdoutPath, { label: '标准输出日志路径' });
  run.stderrPath = toPortablePath(paths, stderrPath, { label: '错误日志路径' });
  return { run, stdoutPath, stderrPath };
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
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  run.markFailed(normalizedError);
  run.exitCode = 1;
}

function describeSubscriptionSource(source) {
  if (source?.type === 'github-repo') {
    const branch = source.branch ? `#${source.branch}` : '';
    const subPath = source.subPath ? `/${source.subPath}` : '';
    return `GitHub 仓库 ${source.owner}/${source.repo}${subPath}${branch}`;
  }
  if (source?.type === 'github-file' || source?.type === 'github-raw-file') {
    return `GitHub 文件 ${source.owner}/${source.repo}/${source.repoPath}`;
  }
  if (source?.type === 'http-file') return `HTTP 文件 ${source.url}`;
  return '未知订阅源';
}

function extractScriptCron(content) {
  const text = String(content || '').split(/\r?\n/).slice(0, 160).join('\n');
  const envName = extractEnvTaskName(text);
  const quotedMatch = text.match(/^\s*(?:\/\/|\/\*|\*|#)?\s*cron\s+["']([^"']+)["'](?:\s+([^,\s]+))?(?:.*?tag[:：]\s*([^\r\n]+))?/im);
  if (quotedMatch) {
    const cron = normalizeScriptCron(quotedMatch[1]);
    if (cron) {
      return {
        cron,
        rawCron: quotedMatch[1],
        name: envName || normalizeTaskName(quotedMatch[3]) || normalizeTaskName(quotedMatch[2])
      };
    }
  }

  const colonMatch = text.match(/^\s*(?:\/\/|\/\*|\*|#)?\s*@?cron\s*[:=]\s*([^\r\n]+)/im);
  if (colonMatch) {
    const raw = colonMatch[1].trim();
    const cron = normalizeScriptCron(raw);
    if (cron) {
      return {
        cron,
        rawCron: raw,
        name: envName
      };
    }
  }

  const atCronMatch = text.match(/^\s*(?:\/\/|\/\*|\*|#)?\s*@cron\s+([^\r\n]+)/im);
  if (atCronMatch) {
    const raw = atCronMatch[1].trim();
    const cron = normalizeScriptCron(raw);
    if (cron) {
      return {
        cron,
        rawCron: raw,
        name: envName
      };
    }
  }

  return undefined;
}

function extractEnvTaskName(text) {
  const match = String(text || '').match(/\bnew\s+Env\s*\(\s*(['"`])([^'"`]{1,120})\1\s*\)/m);
  return normalizeTaskName(match?.[2]);
}

function normalizeScriptCron(value) {
  const cronTokens = String(value || '')
    .replace(/^["']|["']$/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => /^[\d*,/\-]+$/.test(token));
  if (cronTokens.length < 5) return '';
  const fields = cronTokens.length >= 6 ? cronTokens.slice(1, 6) : cronTokens.slice(0, 5);
  return fields.join(' ');
}

function normalizeTaskName(value) {
  const name = String(value || '')
    .replace(/\.(cjs|mjs|js)$/i, '')
    .replace(/^jd_/, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, ' ')
    .trim();
  return name || '';
}

function createTaskNameFromScriptPath(scriptPath) {
  return normalizeTaskName(path.posix.basename(String(scriptPath || ''))) || '订阅脚本任务';
}

function createUniqueTaskName(baseName, usedTaskNames, currentName = '') {
  const normalizedBase = normalizeTaskName(baseName) || '订阅脚本任务';
  if (currentName && normalizedBase === currentName) return normalizedBase;
  if (!usedTaskNames.has(normalizedBase)) return normalizedBase;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalizedBase} (${index})`;
    if (candidate === currentName || !usedTaskNames.has(candidate)) return candidate;
  }

  return `${normalizedBase} (${Date.now()})`;
}

function isSubscriptionManagedTask(task, subscription) {
  const labels = new Set(task.labels || []);
  const remark = String(task.remark || '');
  return labels.has('订阅') ||
    (subscription?.name && labels.has(subscription.name)) ||
    (subscription?.name && remark.includes(`订阅「${subscription.name}」自动创建`));
}

function mergeTaskLabels(currentLabels = [], nextLabels = []) {
  return [...new Set([
    ...currentLabels.map((label) => String(label).trim()).filter(Boolean),
    ...nextLabels.map((label) => String(label).trim()).filter(Boolean)
  ])];
}

function sameStringArray(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function formatAutoCreateTaskSummary(summary) {
  if (!summary?.enabled) return '';
  const parts = [];
  if (summary.created) parts.push(`自动创建 ${summary.created} 个任务`);
  if (summary.updatedExisting) parts.push(`自动更新 ${summary.updatedExisting} 个任务`);
  if (summary.skippedExisting) parts.push(`跳过已存在 ${summary.skippedExisting} 个`);
  if (summary.skippedNoCron) parts.push(`无 cron ${summary.skippedNoCron} 个`);
  if (summary.skippedInvalidCron) parts.push(`无效 cron ${summary.skippedInvalidCron} 个`);
  return parts.join('，');
}

function createSubscriptionFolder(name, id, source = undefined) {
  const namedFolder = sanitizePathPart(name);
  if (namedFolder) return namedFolder;
  if (source?.owner && source?.repo) {
    const owner = sanitizePathPart(source.owner);
    const repo = sanitizePathPart(source.repo);
    const branch = sanitizePathPart(source.branch);
    return [owner, repo, branch].filter(Boolean).join('_');
  }
  const base = sanitizePathPart(name) || 'subscription';
  return `${base}-${String(id || randomUUID()).slice(0, 8)}`;
}

async function pruneEmptyDirectories(root) {
  await removeEmptyChildren(root, root);
}

async function removeEmptyChildren(root, current) {
  await assertInside(root, current);
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(current, entry.name);
    await removeEmptyChildren(root, fullPath);
    const remaining = await readdir(fullPath);
    if (remaining.length === 0) await rmdir(fullPath);
  }
}

function sanitizePathPart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function normalizeRelative(value) {
  return String(value || '').replace(/^data[\\/]+scripts[\\/]+/, '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function stripScriptPrefix(value) {
  return String(value || '').replace(/^data[\\/]+scripts[\\/]+/, '');
}

function toDataScriptPath(root, fullPath) {
  return `data/scripts/${path.relative(root, fullPath).replaceAll(path.sep, '/')}`;
}

function sanitizeFileName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

async function assertInside(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('PATH_OUTSIDE_DATA', '路径必须位于 data 目录内');
  }
}

async function readJsonOptional(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function ensureSubscriptionSupportFiles(scriptTargetRoot) {
  await mkdir(scriptTargetRoot, { recursive: true });
  for (const [name, content] of Object.entries(DEFAULT_SCRIPT_SUPPORT_FILES)) {
    const filePath = path.join(scriptTargetRoot, name);
    try {
      await access(filePath, constants.R_OK);
    } catch {
      await writeFile(filePath, content, 'utf8');
    }
  }
}

async function copySubscriptionScript(input) {
  const sourcePath = path.join(input.sourceRoot, normalizeRelativePath(input.relativePath));
  const targetPath = path.join(input.targetRoot, normalizeRelativePath(input.relativePath));
  await copySingleFile(sourcePath, targetPath, input.targetRoot);
}

async function copySingleFile(sourcePath, targetPath, root) {
  await assertInside(root, targetPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const content = await readFile(sourcePath, 'utf8');
  await writeFile(targetPath, content, 'utf8');
}

function runProcess(command, args, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: paths.dataRoot,
      windowsHide: true,
      env: createPortableProcessEnv(paths)
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError('DEPENDENCY_COMMAND_FAILED', stderr || `依赖命令失败，退出码 ${code}`));
    });
  });
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


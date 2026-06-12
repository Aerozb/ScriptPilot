import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { JsonStore } from '../../../shared/infrastructure/filesystem/json-store.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { createPortableProcessEnv } from '../../../bootstrap/portable-paths.js';
import { resolveNodeRuntime } from '../../runtime/infrastructure/node-runtime-resolver.js';
import { resolveGitRuntime } from '../../runtime/infrastructure/git-runtime-resolver.js';

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
const MAX_SUBSCRIPTION_LOG_CHARS = 120000;
const GITHUB_ACCELERATOR_BASE_URL = 'https://ghfast.top/';

export class LocalQinglongService {
  constructor(paths) {
    this.paths = paths;
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

  async runSubscription(id) {
    const rows = await this.subscriptionStore.read();
    const index = rows.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError('SUBSCRIPTION_NOT_FOUND', `订阅不存在: ${id}`);
    const logger = createSubscriptionLogger(rows[index]);
    try {
      logger.info(`开始拉取订阅：${rows[index].name}`);
      const result = await pullSubscriptionFiles({
        subscription: rows[index],
        paths: this.paths,
        scriptRoot: this.scriptRoot,
        repoRoot: this.repoRoot,
        rawRoot: this.rawRoot,
        logger
      });
      logger.info(`拉取完成：${result.files.length} 个文件 -> ${result.localPath}`);
      rows[index] = {
        ...rows[index],
        subscriptionFolder: result.subscriptionFolder,
        localPath: result.localPath,
        repoPath: result.repoPath,
        lastPulledAt: new Date().toISOString(),
        lastResult: `已拉取 ${result.files.length} 个文件到 ${result.localPath}`,
        lastLog: logger.toText(),
        lastFiles: result.files,
        lastError: undefined,
        sourceType: result.sourceType,
        updatedAt: new Date().toISOString()
      };
      await this.subscriptionStore.write(rows);
      return rows[index];
    } catch (error) {
      const message = error instanceof AppError ? error.message : String(error?.message || error);
      logger.error(`拉取失败：${message}`);
      rows[index] = {
        ...rows[index],
        lastPulledAt: new Date().toISOString(),
        lastResult: `拉取失败: ${message}`,
        lastLog: logger.toText(),
        lastError: message,
        updatedAt: new Date().toISOString()
      };
      await this.subscriptionStore.write(rows);
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
  const items = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      items.push(...await listFilesRecursive(root, fullPath));
    } else if (entry.isFile()) {
      const fileStat = await stat(fullPath);
      items.push({
        name: entry.name,
        path: toDataScriptPath(root, fullPath),
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString()
      });
    }
  }
  return items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function pullSubscriptionFiles(input) {
  if (!input.subscription?.url?.trim()) {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址不能为空');
  }

  const logger = input.logger;
  const source = parseSubscriptionSource(input.subscription);
  logger?.info(`解析订阅源：${describeSubscriptionSource(source)}`);
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
  logger?.info(`脚本目录：data/scripts/${subscriptionFolder}`);
  logger?.info(`仓库缓存：data/repo/${subscriptionFolder}`);

  const currentFolder = sanitizePathPart(subscriptionFolder);
  if (previousFolder && previousFolder !== currentFolder) {
    logger?.info(`订阅目录名已变化，清理旧目录：${previousFolder}`);
    const oldScriptFolderPath = path.join(input.scriptRoot, previousFolder);
    const oldRepoFolderPath = path.join(repoRoot, previousFolder);
    const oldRawFilePath = path.join(rawRoot, `${previousFolder}.js`);
    await assertInside(input.scriptRoot, oldScriptFolderPath);
    await assertInside(repoRoot, oldRepoFolderPath);
    await assertInside(rawRoot, oldRawFilePath);
    await rm(oldScriptFolderPath, { recursive: true, force: true });
    await rm(oldRepoFolderPath, { recursive: true, force: true });
    await rm(oldRawFilePath, { force: true });
  }

  for (const folder of new Set([currentFolder].filter(Boolean))) {
    const scriptFolderPath = path.join(input.scriptRoot, folder);
    const rawFilePath = path.join(rawRoot, `${folder}.js`);
    await assertInside(input.scriptRoot, scriptFolderPath);
    await assertInside(rawRoot, rawFilePath);
    await rm(scriptFolderPath, { recursive: true, force: true });
    await rm(rawFilePath, { force: true });
  }
  await mkdir(scriptTargetRoot, { recursive: true });
  logger?.info('已清理本次导入目录，准备重新导入脚本');

  const result = await downloadSubscriptionSource(source, {
    paths: input.paths,
    repoRoot: repoTargetRoot,
    rawRoot,
    rawFilePath: rawTargetPath,
    scriptRoot: scriptTargetRoot,
    subscriptionFolder,
    logger
  });
  const files = result.files;
  if (!files.length) {
    throw new AppError('SUBSCRIPTION_EMPTY', '订阅源没有找到可导入的 NodeJS 脚本文件');
  }

  await ensureSubscriptionSupportFiles(scriptTargetRoot);
  logger?.success(`导入完成：${files.length} 个文件`);
  logFileList(logger, '导入清单', files);

  return {
    subscriptionFolder,
    sourceType: source.type,
    localPath: `data/scripts/${subscriptionFolder}`,
    repoPath: result.repoPath,
    files: files.map((file) => `data/scripts/${subscriptionFolder}/${file}`.replaceAll('\\', '/'))
  };
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

async function downloadSubscriptionSource(source, targets) {
  if (source.type === 'github-repo') return downloadGitHubRepository(source, targets);
  if (source.type === 'github-file' || source.type === 'github-raw-file') return downloadGitHubFile(source, targets);
  if (source.type === 'http-file') return downloadHttpFile(source, targets);
  throw new AppError('UNSUPPORTED_SUBSCRIPTION_SOURCE', '不支持的订阅源类型');
}

async function downloadGitHubRepository(source, targets) {
  if (!targets.paths) {
    throw new AppError('PORTABLE_PATHS_REQUIRED', '仓库订阅缺少绿色目录上下文');
  }

  const logger = targets.logger;
  const prefix = normalizeRepoPath(source.subPath);
  const gitRuntime = await resolveGitRuntime(targets.paths);
  const cloneUrl = createGitHubCloneUrl(source);
  logger?.info(`Git 运行时：${gitRuntime.version || 'unknown'}（${gitRuntime.source || 'unknown'}）`);
  logger?.info(`仓库地址：${cloneUrl}`);
  if (source.branch) logger?.info(`指定分支：${source.branch}`);
  if (prefix) logger?.info(`仓库子目录：${prefix}`);
  await syncGitRepositoryWithFallback({
    gitRuntime,
    paths: targets.paths,
    cloneUrl,
    branch: source.branch,
    targetRoot: targets.repoRoot,
    logger
  });

  const sourceRoot = prefix ? path.join(targets.repoRoot, prefix) : targets.repoRoot;
  await assertInside(targets.repoRoot, sourceRoot);
  await assertDirectoryExists(sourceRoot, 'SUBSCRIPTION_SUBPATH_NOT_FOUND', `订阅仓库目录不存在: ${prefix || '/'}`);
  logger?.info(`扫描仓库文件：${prefix || '/'}`);

  const repoEntries = await listPullableRepositoryFiles({
    sourceRoot,
    filters: source.filters
  });
  logger?.info(`筛选到可导入文件：${repoEntries.length} 个`);

  const written = [];
  for (const entry of repoEntries) {
    await copySubscriptionScript({
      sourceRoot,
      targetRoot: targets.scriptRoot,
      relativePath: entry.path
    });
    written.push(normalizeRelativePath(entry.path));
  }

  return {
    repoPath: `data/repo/${targets.subscriptionFolder}`,
    files: written
  };
}

async function downloadGitHubFile(source, targets) {
  const logger = targets.logger;
  const repoPath = normalizeRepoPath(source.repoPath);
  if (!pathShouldBePulled(repoPath, source.filters)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', '订阅文件只支持 .js、.mjs、.cjs 或 package.json');
  }
  const branch = source.branch || await resolveGitHubBranch(source);
  const rawUrl = source.rawUrl || createGitHubRawUrl(source.owner, source.repo, branch, repoPath);
  const relativePath = path.posix.basename(repoPath);
  logger?.info(`下载 GitHub 文件：${source.owner}/${source.repo}/${repoPath}`);
  logger?.info(`文件分支：${branch}`);
  await writeRemoteFile({
    url: rawUrl,
    fallbackUrl: createGitHubAcceleratedUrl(rawUrl),
    targetRoot: targets.repoRoot,
    relativePath,
    logger
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

async function downloadHttpFile(source, targets) {
  const logger = targets.logger;
  const relativePath = sanitizePathPart(source.fileName);
  if (!pathShouldBePulled(relativePath)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', '普通 HTTP 订阅只支持 .js、.mjs、.cjs 或 package.json');
  }
  logger?.info(`下载 HTTP 文件：${source.fileName}`);
  await writeRemoteFile({
    url: source.url,
    targetRoot: targets.rawRoot,
    relativePath: path.basename(targets.rawFilePath),
    logger
  });
  await copySingleFile(targets.rawFilePath, path.join(targets.scriptRoot, relativePath), targets.scriptRoot);
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
  input.logger?.info(`请求远程文件：${input.url}`);

  let content;
  try {
    content = await fetchText(input.url, `下载文件失败: ${safeRelativePath}`);
  } catch (error) {
    if (!input.fallbackUrl || input.fallbackUrl === input.url) throw error;
    input.logger?.warn(`直连下载失败，切换 ghfast 加速重试：${formatLogError(error)}`);
    input.logger?.info(`请求 ghfast 加速文件：${input.fallbackUrl}`);
    content = await fetchText(input.fallbackUrl, `ghfast 加速下载文件失败: ${safeRelativePath}`);
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_SUBSCRIPTION_FILE_BYTES) {
    throw new AppError('SUBSCRIPTION_FILE_TOO_LARGE', `订阅文件过大: ${safeRelativePath}`);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  input.logger?.success(`保存远程文件：${safeRelativePath}（${formatBytes(size)}）`);
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
      input.logger?.warn(`GitHub 直连拉取失败，切换 ${attempt.name} 重试`);
      await rm(input.targetRoot, { recursive: true, force: true });
    }

    try {
      input.logger?.info(`拉取方式：${attempt.name}`);
      await syncGitRepository({
        ...input,
        cloneUrl: attempt.cloneUrl
      });
      if (index > 0) input.logger?.success(`${attempt.name} 拉取成功`);
      return;
    } catch (error) {
      lastError = error;
      input.logger?.warn(`${attempt.name} 拉取失败：${formatLogError(error)}`);
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
    input.logger?.info('检测到已有 Git 仓库，执行增量更新');
    try {
      await updateGitRepository(input);
      return;
    } catch (error) {
      input.logger?.warn(`增量更新失败，将删除缓存后重新克隆：${formatLogError(error)}`);
      await rm(input.targetRoot, { recursive: true, force: true });
    }
  } else {
    input.logger?.info('未检测到本地仓库，执行首次克隆');
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
    logger: input.logger
  });
}

async function updateGitRepository(input) {
  await runGitCommand({
    gitRuntime: input.gitRuntime,
    paths: input.paths,
    args: ['remote', 'set-url', 'origin', input.cloneUrl],
    cwd: input.targetRoot,
    label: '更新订阅仓库地址',
    logger: input.logger
  });

  if (input.branch) {
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['fetch', '--depth=1', 'origin', input.branch],
      cwd: input.targetRoot,
      label: '拉取订阅仓库分支',
      logger: input.logger
    });
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['checkout', '-B', input.branch, 'FETCH_HEAD'],
      cwd: input.targetRoot,
      label: '切换订阅仓库分支',
      logger: input.logger
    });
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['reset', '--hard', 'FETCH_HEAD'],
      cwd: input.targetRoot,
      label: '重置订阅仓库',
      logger: input.logger
    });
  } else {
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['pull', '--ff-only', '--depth=1'],
      cwd: input.targetRoot,
      label: '更新订阅仓库',
      logger: input.logger
    });
    await runGitCommand({
      gitRuntime: input.gitRuntime,
      paths: input.paths,
      args: ['reset', '--hard', 'HEAD'],
      cwd: input.targetRoot,
      label: '重置订阅仓库',
      logger: input.logger
    });
  }

  await runGitCommand({
    gitRuntime: input.gitRuntime,
    paths: input.paths,
    args: ['clean', '-ffd'],
    cwd: input.targetRoot,
    label: '清理订阅仓库',
    logger: input.logger
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
    input.logger?.command(input.label, createGitCommandLine(input.gitRuntime.gitPath, input.args), input.cwd);
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
      input.logger?.error(`${input.label} 启动失败：${error.message}`);
      reject(new AppError('GIT_COMMAND_SPAWN_FAILED', `${input.label}启动失败: ${error.message}`, {
        gitPath: input.gitRuntime.gitPath,
        args: input.args,
        code: error.code
      }));
    });

    child.on('close', (code) => {
      const duration = formatDuration(Date.now() - startedAt);
      if (stdout.trim()) input.logger?.output('stdout', stdout);
      if (stderr.trim()) input.logger?.output('stderr', stderr);
      if (code === 0) {
        input.logger?.success(`${input.label} 完成（${duration}）`);
        resolve({ stdout, stderr });
        return;
      }
      input.logger?.error(`${input.label} 失败（退出码 ${code}，${duration}）`);
      reject(new AppError('GIT_COMMAND_FAILED', `${input.label}失败: ${stderr || stdout || `退出码 ${code}`}`, {
        gitPath: input.gitRuntime.gitPath,
        args: input.args,
        exitCode: code,
        stdout,
        stderr
      }));
    });
  });
}

function createSubscriptionLogger(subscription) {
  const lines = [];
  let totalChars = 0;
  let truncated = false;

  const addLine = (line) => {
    const safeLine = redactLogText(line);
    lines.push(safeLine);
    totalChars += safeLine.length + 1;
    while (totalChars > MAX_SUBSCRIPTION_LOG_CHARS && lines.length > 1) {
      const removed = lines.shift();
      totalChars -= removed.length + 1;
      truncated = true;
    }
  };

  const push = (level, message) => {
    const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const text = String(message ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const line of text.split('\n')) {
      addLine(`[${timestamp}] [${level}] ${line}`);
    }
  };

  push('信息', `订阅：${subscription?.name || '未命名订阅'}`);
  push('信息', `地址：${subscription?.url || '-'}`);

  return {
    info: (message) => push('信息', message),
    success: (message) => push('成功', message),
    warn: (message) => push('警告', message),
    error: (message) => push('错误', message),
    command: (label, commandLine, cwd) => {
      push('命令', `${label}\n目录：${cwd || '-'}\n${commandLine}`);
    },
    output: (label, output) => {
      const text = String(output || '').trimEnd();
      if (text) push(label, text);
    },
    toText: () => {
      const body = lines.join('\n');
      if (!body) return '暂无日志';
      return truncated ? `日志过长，已保留最近 ${Math.round(MAX_SUBSCRIPTION_LOG_CHARS / 1024)}KB。\n${body}` : body;
    }
  };
}

function describeSubscriptionSource(source) {
  if (source.type === 'github-repo') {
    const branch = source.branch ? `，分支 ${source.branch}` : '';
    const subPath = source.subPath ? `，目录 ${source.subPath}` : '';
    return `GitHub 仓库 ${source.owner}/${source.repo}${branch}${subPath}`;
  }
  if (source.type === 'github-file' || source.type === 'github-raw-file') {
    const branch = source.branch ? `，分支 ${source.branch}` : '';
    return `GitHub 文件 ${source.owner}/${source.repo}/${source.repoPath}${branch}`;
  }
  if (source.type === 'http-file') {
    return `HTTP 文件 ${source.fileName}`;
  }
  return source.type || '未知类型';
}

function logFileList(logger, title, files = []) {
  if (!logger || !files.length) return;
  const visibleFiles = files.slice(0, 80);
  logger.info(`${title}：${files.length} 个文件`);
  for (const file of visibleFiles) {
    logger.info(`  - ${file}`);
  }
  if (files.length > visibleFiles.length) {
    logger.info(`  ... 还有 ${files.length - visibleFiles.length} 个文件未展开显示`);
  }
}

function createGitCommandLine(gitPath, args = []) {
  const command = path.basename(gitPath || 'git') || 'git';
  return [command, ...args].map(formatCommandPart).join(' ');
}

function formatCommandPart(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function formatLogError(error) {
  const message = error instanceof AppError ? error.message : String(error?.message || error);
  return redactLogText(message).split('\n').slice(0, 12).join('\n');
}

function redactLogText(value) {
  return String(value ?? '')
    .replace(/\b(pt_key=)[^;&\s]+/gi, '$1***')
    .replace(/\b(pt_pin=)[^;&\s]+/gi, '$1***')
    .replace(/([?&](?:access_token|token|key|password|passwd|pwd)=)[^&#\s]+/gi, '$1***')
    .replace(/\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***@')
    .replace(/\b(Authorization:\s*(?:Bearer|token)\s+)[^\s]+/gi, '$1***');
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function createGitProcessEnv(paths, gitRuntime) {
  const env = createPortableProcessEnv(paths, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(paths.dataRoot, 'configs', '.gitconfig'),
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: 'echo'
  });
  const pathParts = [];
  if (gitRuntime.gitRoot) {
    pathParts.push(
      path.join(gitRuntime.gitRoot, 'cmd'),
      path.join(gitRuntime.gitRoot, 'mingw64', 'bin'),
      path.join(gitRuntime.gitRoot, 'usr', 'bin')
    );
  }
  pathParts.push(env.Path || env.PATH || '');
  return {
    ...env,
    PATH: pathParts.filter(Boolean).join(path.delimiter),
    Path: pathParts.filter(Boolean).join(path.delimiter)
  };
}

async function assertDirectoryExists(directoryPath, code, message) {
  try {
    const directoryStat = await stat(directoryPath);
    if (!directoryStat.isDirectory()) throw new Error('not directory');
  } catch {
    throw new AppError(code, message, { path: directoryPath });
  }
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
      const relativePath = path.relative(input.sourceRoot, fullPath).replaceAll(path.sep, '/');
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

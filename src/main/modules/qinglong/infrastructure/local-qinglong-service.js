import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { JsonStore } from '../../../shared/infrastructure/filesystem/json-store.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { createPortableProcessEnv } from '../../../bootstrap/portable-paths.js';
import { resolveNodeRuntime } from '../../runtime/infrastructure/node-runtime-resolver.js';

const DEFAULT_CONFIGS = {
  'config.sh': '# ScriptPilot 本地青龙版配置\nexport QL_DIR=\"$PWD\"\n',
  'notify.js': 'module.exports = async function notify(title, content) {\n  console.log(`[notify] ${title}: ${content}`);\n};\n',
  'extra.sh': '# 自定义 Shell 配置\n',
  'package.json': '{\n  "dependencies": {}\n}\n'
};
const SCRIPT_SUBSCRIPTION_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SUBSCRIPTION_SUPPORT_FILES = new Set(['package.json']);
const MAX_SUBSCRIPTION_FILES = 500;
const MAX_SUBSCRIPTION_FILE_BYTES = 5 * 1024 * 1024;

export class LocalQinglongService {
  constructor(paths) {
    this.paths = paths;
    this.envStore = new JsonStore(path.join(paths.appStateRoot, 'envs.json'), []);
    this.subscriptionStore = new JsonStore(path.join(paths.appStateRoot, 'subscriptions.json'), []);
    this.dependencyHistoryStore = new JsonStore(path.join(paths.appStateRoot, 'dependency-history.json'), []);
    this.configRoot = path.join(paths.dataRoot, 'configs');
    this.scriptRoot = paths.scriptsRoot;
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
      const filePath = path.join(this.scriptRoot, normalizeRelative(stripScriptPrefix(item)));
      await assertInside(this.scriptRoot, filePath);
      await rm(filePath, { force: true });
    }
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
    const next = {
      ...existing,
      id,
      name: input.name.trim(),
      url: String(input.url ?? ''),
      branch: String(input.branch ?? ''),
      schedule: String(input.schedule ?? ''),
      status: input.status === 'disabled' ? 'disabled' : 'enabled',
      subscriptionFolder: existing.subscriptionFolder || createSubscriptionFolder(input.name, id),
      lastPulledAt: input.lastPulledAt || existing.lastPulledAt,
      lastResult: existing.lastResult,
      lastFiles: existing.lastFiles || [],
      localPath: existing.localPath,
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
      const folderPath = path.join(this.scriptRoot, 'subscriptions', sanitizePathPart(row.subscriptionFolder));
      await assertInside(this.scriptRoot, folderPath);
      await rm(folderPath, { recursive: true, force: true });
    }
    await this.subscriptionStore.write(rows.filter((item) => !idSet.has(item.id)));
    return { deleted: ids.length };
  }

  async runSubscription(id) {
    const rows = await this.subscriptionStore.read();
    const index = rows.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError('SUBSCRIPTION_NOT_FOUND', `订阅不存在: ${id}`);
    try {
      const result = await pullSubscriptionFiles({
        subscription: rows[index],
        scriptRoot: this.scriptRoot
      });
      rows[index] = {
        ...rows[index],
        subscriptionFolder: result.subscriptionFolder,
        localPath: result.localPath,
        lastPulledAt: new Date().toISOString(),
        lastResult: `已拉取 ${result.files.length} 个文件到 ${result.localPath}`,
        lastFiles: result.files,
        lastError: undefined,
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
    const npmPath = path.join(path.dirname(runtime.nodePath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    await runProcess(npmPath, ['install', String(name).trim(), '--prefix', this.paths.dataRoot, '--cache', path.join(this.paths.cacheRoot, 'npm')], this.paths);
    await this.appendDependencyHistory({ action: 'install', name: String(name).trim(), status: 'success' });
    return this.listDependencies();
  }

  async removeDependency(name) {
    if (!name || !String(name).trim()) throw new AppError('INVALID_DEPENDENCY_NAME', '依赖名称不能为空');
    const runtime = await resolveNodeRuntime(this.paths);
    const npmPath = path.join(path.dirname(runtime.nodePath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    await runProcess(npmPath, ['uninstall', String(name).trim(), '--prefix', this.paths.dataRoot, '--cache', path.join(this.paths.cacheRoot, 'npm')], this.paths);
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

  const source = parseSubscriptionSource(input.subscription);
  const subscriptionFolder = input.subscription.subscriptionFolder || createSubscriptionFolder(input.subscription.name, input.subscription.id);
  const targetRoot = path.join(input.scriptRoot, 'subscriptions', sanitizePathPart(subscriptionFolder));
  await assertInside(input.scriptRoot, targetRoot);
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });

  const files = await downloadSubscriptionSource(source, targetRoot);
  if (!files.length) {
    throw new AppError('SUBSCRIPTION_EMPTY', '订阅源没有找到可导入的 NodeJS 脚本文件');
  }

  return {
    subscriptionFolder,
    sourceType: source.type,
    localPath: `data/scripts/subscriptions/${subscriptionFolder}`,
    files: files.map((file) => `data/scripts/subscriptions/${subscriptionFolder}/${file}`.replaceAll('\\', '/'))
  };
}

function parseSubscriptionSource(subscription) {
  let parsed;
  try {
    parsed = new URL(subscription.url);
  } catch {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址必须是 http 或 https 地址');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址只支持 http 和 https');
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
      rawUrl: parsed.toString()
    };
  }

  if (parsed.hostname === 'github.com') {
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new AppError('INVALID_GITHUB_URL', 'GitHub 地址需要包含 owner/repo');
    }

    const branch = String(subscription.branch || '').trim();
    if (segments[2] === 'blob' || segments[2] === 'raw') {
      if (segments.length < 5) throw new AppError('INVALID_GITHUB_FILE_URL', 'GitHub 文件地址格式不正确');
      return {
        type: 'github-file',
        owner: segments[0],
        repo: segments[1],
        branch: branch || segments[3],
        repoPath: segments.slice(4).join('/')
      };
    }

    if (segments[2] === 'tree') {
      if (segments.length < 4) throw new AppError('INVALID_GITHUB_TREE_URL', 'GitHub 目录地址格式不正确');
      return {
        type: 'github-repo',
        owner: segments[0],
        repo: segments[1],
        branch: branch || segments[3],
        subPath: segments.slice(4).join('/')
      };
    }

    return {
      type: 'github-repo',
      owner: segments[0],
      repo: segments[1],
      branch: branch || 'main',
      subPath: ''
    };
  }

  return {
    type: 'http-file',
    url: parsed.toString(),
    fileName: path.posix.basename(decodeURIComponent(parsed.pathname)) || 'downloaded-script.js'
  };
}

async function downloadSubscriptionSource(source, targetRoot) {
  if (source.type === 'github-repo') return downloadGitHubRepository(source, targetRoot);
  if (source.type === 'github-file' || source.type === 'github-raw-file') return downloadGitHubFile(source, targetRoot);
  if (source.type === 'http-file') return downloadHttpFile(source, targetRoot);
  throw new AppError('UNSUPPORTED_SUBSCRIPTION_SOURCE', '不支持的订阅源类型');
}

async function downloadGitHubRepository(source, targetRoot) {
  const tree = await fetchJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.branch)}?recursive=1`,
    '读取 GitHub 仓库目录失败'
  );
  const prefix = normalizeRepoPath(source.subPath);
  const fileEntries = (tree.tree || [])
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => pathShouldBePulled(entry.path))
    .filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
    .slice(0, MAX_SUBSCRIPTION_FILES);

  const written = [];
  for (const entry of fileEntries) {
    const relativePath = prefix ? entry.path.slice(prefix.length).replace(/^\/+/, '') : entry.path;
    const rawUrl = createGitHubRawUrl(source.owner, source.repo, source.branch, entry.path);
    await writeRemoteFile({
      url: rawUrl,
      targetRoot,
      relativePath
    });
    written.push(normalizeRelativePath(relativePath));
  }
  return written;
}

async function downloadGitHubFile(source, targetRoot) {
  const repoPath = normalizeRepoPath(source.repoPath);
  if (!pathShouldBePulled(repoPath)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', '订阅文件只支持 .js、.mjs、.cjs 或 package.json');
  }
  const rawUrl = source.rawUrl || createGitHubRawUrl(source.owner, source.repo, source.branch, repoPath);
  const relativePath = path.posix.basename(repoPath);
  await writeRemoteFile({
    url: rawUrl,
    targetRoot,
    relativePath
  });
  return [relativePath];
}

async function downloadHttpFile(source, targetRoot) {
  const relativePath = sanitizePathPart(source.fileName);
  if (!pathShouldBePulled(relativePath)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', '普通 HTTP 订阅只支持 .js、.mjs、.cjs 或 package.json');
  }
  await writeRemoteFile({
    url: source.url,
    targetRoot,
    relativePath
  });
  return [relativePath];
}

async function writeRemoteFile(input) {
  const safeRelativePath = normalizeRelativePath(input.relativePath);
  if (!safeRelativePath) return;

  const filePath = path.join(input.targetRoot, safeRelativePath);
  await assertInside(input.targetRoot, filePath);

  const content = await fetchText(input.url, `下载文件失败: ${safeRelativePath}`);
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_SUBSCRIPTION_FILE_BYTES) {
    throw new AppError('SUBSCRIPTION_FILE_TOO_LARGE', `订阅文件过大: ${safeRelativePath}`);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
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

function createGitHubRawUrl(owner, repo, branch, repoPath) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

function pathShouldBePulled(value) {
  const normalized = normalizeRelativePath(value);
  const basename = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(basename);
  return SCRIPT_SUBSCRIPTION_EXTENSIONS.has(ext) || SUBSCRIPTION_SUPPORT_FILES.has(basename);
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

function createSubscriptionFolder(name, id) {
  const base = sanitizePathPart(name) || 'subscription';
  return `${base}-${String(id || randomUUID()).slice(0, 8)}`;
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

import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../../shared/errors/app-error.js';
import { assertInside, normalizeRelativePath, normalizeRepoPath, sanitizePathPart } from './fs-utils.js';
import { createSubscriptionFolder, describeSubscriptionSource, parseSubscriptionSource } from './subscription-source.js';

/*
 * 订阅下载器：按 source 类型把远程脚本拉到 data/repo（原始镜像）并按青龙规则
 * 筛选导入到 data/scripts/<订阅目录>。
 */

const DEFAULT_SCRIPT_SUPPORT_FILES = {
  'sendNotify.js': `async function sendNotify(title, content) {\n  console.log(\`[sendNotify] \${title}: \${content}\`);\n}\n\nmodule.exports = { sendNotify };\n`
};
const SCRIPT_SUBSCRIPTION_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SUBSCRIPTION_SUPPORT_FILES = new Set(['package.json']);
const MAX_REPOSITORY_FILES = 2000;
const MAX_SUBSCRIPTION_FILE_BYTES = 5 * 1024 * 1024;
const REMOTE_REQUEST_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_CONCURRENCY = 6;

export async function pullSubscriptionFiles(input) {
  if (!input.subscription?.url?.trim()) {
    throw new AppError('INVALID_SUBSCRIPTION_URL', '订阅地址不能为空');
  }

  const log = typeof input.log === 'function' ? input.log : async () => {};
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
    assertInside(input.scriptRoot, scriptFolderPath);
    assertInside(repoRoot, repoFolderPath);
    assertInside(rawRoot, rawFilePath);
    await log(`清理本地缓存和脚本目录：${folder}`);
    await rm(scriptFolderPath, { recursive: true, force: true });
    await rm(repoFolderPath, { recursive: true, force: true });
    await rm(rawFilePath, { force: true });
  }
  await mkdir(scriptTargetRoot, { recursive: true });

  const result = await downloadSubscriptionSource(source, {
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
  await log('写入青龙兼容支持文件：sendNotify.js');
  await log(`订阅拉取完成：${files.length} 个脚本文件`);

  return {
    subscriptionFolder,
    sourceType: source.type,
    localPath: `data/scripts/${subscriptionFolder}`,
    repoPath: result.repoPath,
    files: files.map((file) => `data/scripts/${subscriptionFolder}/${file}`.replaceAll('\\', '/'))
  };
}

async function downloadSubscriptionSource(source, targets, log) {
  if (source.type === 'github-repo') return downloadGitHubRepository(source, targets, log);
  if (source.type === 'github-file' || source.type === 'github-raw-file') return downloadGitHubFile(source, targets, log);
  if (source.type === 'http-file') return downloadHttpFile(source, targets, log);
  throw new AppError('UNSUPPORTED_SUBSCRIPTION_SOURCE', '不支持的订阅源类型');
}

async function downloadGitHubRepository(source, targets, log) {
  const branch = await resolveGitHubBranch(source);
  await log(`读取 GitHub 仓库：${source.owner}/${source.repo}#${branch}`);
  const tree = await fetchJson(
    `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    '读取 GitHub 仓库目录失败'
  );
  const prefix = normalizeRepoPath(source.subPath);
  const repoEntries = (tree.tree || [])
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
    .slice(0, MAX_REPOSITORY_FILES);

  await log(`仓库文件扫描完成：${repoEntries.length} 个文件，开始按青龙规则筛选脚本`);
  // 有界并发下载，避免大仓库逐个串行拉取过慢。
  const results = await mapWithConcurrency(repoEntries, DOWNLOAD_CONCURRENCY, async (entry) => {
    const relativePath = prefix ? entry.path.slice(prefix.length).replace(/^\/+/, '') : entry.path;
    const rawUrl = createGitHubRawUrl(source.owner, source.repo, branch, entry.path);
    await writeRemoteFile({
      url: rawUrl,
      targetRoot: targets.repoRoot,
      relativePath
    });
    if (!pathShouldBePulled(relativePath, source.filters)) return undefined;
    await copySubscriptionScript({
      sourceRoot: targets.repoRoot,
      targetRoot: targets.scriptRoot,
      relativePath
    });
    await log(`导入脚本：${normalizeRelativePath(relativePath)}`);
    return normalizeRelativePath(relativePath);
  });
  return {
    repoPath: `data/repo/${targets.subscriptionFolder}`,
    files: results.filter(Boolean)
  };
}

async function downloadGitHubFile(source, targets, log) {
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
    targetRoot: targets.repoRoot,
    relativePath
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

async function downloadHttpFile(source, targets, log) {
  const relativePath = sanitizePathPart(source.fileName);
  if (!pathShouldBePulled(relativePath)) {
    throw new AppError('UNSUPPORTED_SCRIPT_FILE', '普通 HTTP 订阅只支持 .js、.mjs、.cjs 或 package.json');
  }
  await log(`下载单文件订阅：${source.url}`);
  await writeRemoteFile({
    url: source.url,
    targetRoot: targets.rawRoot,
    relativePath: path.basename(targets.rawFilePath)
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
  assertInside(input.targetRoot, filePath);

  const content = await fetchText(input.url, `下载文件失败: ${safeRelativePath}`);
  if (Buffer.byteLength(content, 'utf8') > MAX_SUBSCRIPTION_FILE_BYTES) {
    throw new AppError('SUBSCRIPTION_FILE_TOO_LARGE', `订阅文件过大: ${safeRelativePath}`);
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function fetchJson(url, errorMessage) {
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ScriptPilot'
    }
  }, errorMessage);

  if (!response.ok) {
    throw new AppError('REMOTE_REQUEST_FAILED', `${errorMessage}: HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchText(url, errorMessage) {
  const response = await fetchWithTimeout(url, {
    headers: { 'user-agent': 'ScriptPilot' }
  }, errorMessage);

  if (!response.ok) {
    throw new AppError('REMOTE_REQUEST_FAILED', `${errorMessage}: HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchWithTimeout(url, options, errorMessage) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AppError('REMOTE_REQUEST_TIMEOUT', `${errorMessage}: 请求超时（${REMOTE_REQUEST_TIMEOUT_MS / 1000} 秒）`);
    }
    throw error;
  }
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
  assertInside(root, targetPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const content = await readFile(sourcePath, 'utf8');
  await writeFile(targetPath, content, 'utf8');
}

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { AppError } from '../../../shared/errors/app-error.js';
import { sanitizePathPart } from './fs-utils.js';

/*
 * 订阅源解析：把用户填写的地址（GitHub 仓库/文件/Raw、ql repo/raw 命令、普通 HTTP）
 * 解析为结构化 source 对象，供下载器按类型分发。
 */

export function parseSubscriptionSource(subscription) {
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
    return httpFileSource(parsed);
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
    return parseGitHubWebSource(parsed, parsedInput, subscription);
  }

  return httpFileSource(parsed);
}

export function describeSubscriptionSource(source) {
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

// 订阅名称优先作为本地脚本目录名。
export function createSubscriptionFolder(name, id, source = undefined) {
  const namedFolder = sanitizePathPart(name);
  if (namedFolder) return namedFolder;
  if (source?.owner && source?.repo) {
    return [source.owner, source.repo, source.branch]
      .map(sanitizePathPart)
      .filter(Boolean)
      .join('_');
  }
  return `subscription-${String(id || randomUUID()).slice(0, 8)}`;
}

export function getSubscriptionSourceCachePath(source, subscriptionFolder) {
  if (source?.type === 'http-file') return `data/raw/${subscriptionFolder}.js`;
  return `data/repo/${subscriptionFolder}`;
}

function httpFileSource(parsed) {
  return {
    type: 'http-file',
    url: parsed.toString(),
    fileName: path.posix.basename(decodeURIComponent(parsed.pathname)) || 'downloaded-script.js'
  };
}

function parseGitHubWebSource(parsed, parsedInput, subscription) {
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
    branch: branch || undefined,
    subPath: '',
    filters: parsedInput.filters
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

// 解析青龙 `ql repo <url> <白名单> <黑名单> <依赖> <分支>` 与 `ql raw <url>` 命令。
function parseQinglongRepoCommand(value) {
  const tokens = splitCommandLine(value);
  const commandIndex = tokens.findIndex((token) => ['repo', 'raw'].includes(token.toLowerCase()));
  if (commandIndex < 0) return undefined;

  const sourceIndex = tokens.findIndex((token, index) => index > commandIndex && looksLikeSubscriptionAddress(token));
  if (sourceIndex < 0) return undefined;

  const extras = tokens.slice(sourceIndex + 1);
  const commandType = tokens[commandIndex].toLowerCase();
  if (commandType === 'raw') {
    return { commandType, address: tokens[sourceIndex] };
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
      if (char === quote) quote = '';
      else token += char;
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

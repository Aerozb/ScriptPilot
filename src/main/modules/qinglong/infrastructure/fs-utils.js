import { readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../../shared/errors/app-error.js';

// data 目录内的路径清洗与安全校验工具，被青龙各服务共用。

export function sanitizePathPart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

export function sanitizeFileName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

export function normalizeRelativePath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .split('/')
    .map((part) => sanitizePathPart(part))
    .filter(Boolean)
    .join('/');
}

export function normalizeRepoPath(value) {
  return normalizeRelativePath(value).replace(/\/+$/, '');
}

// 去掉 data/scripts 前缀并归一化分隔符（保留原始文件名字符）。
export function normalizeScriptRelative(value) {
  return String(value || '').replace(/^data[\\/]+scripts[\\/]+/, '').replaceAll('\\', '/').replace(/^\/+/, '');
}

export function toDataScriptPath(root, fullPath) {
  return `data/scripts/${path.relative(root, fullPath).replaceAll(path.sep, '/')}`;
}

export function assertInside(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('PATH_OUTSIDE_DATA', '路径必须位于 data 目录内');
  }
}

export async function pruneEmptyDirectories(root) {
  await removeEmptyChildren(root, root);
}

async function removeEmptyChildren(root, current) {
  assertInside(root, current);
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(current, entry.name);
    await removeEmptyChildren(root, fullPath);
    const remaining = await readdir(fullPath);
    if (remaining.length === 0) await rmdir(fullPath);
  }
}

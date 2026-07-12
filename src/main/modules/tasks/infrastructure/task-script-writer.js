import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../../shared/errors/app-error.js';
import { assertInsidePath, resolvePortablePath, toPortablePath } from '../../../bootstrap/portable-paths.js';

// 把弹窗里直接填写的脚本内容写入 data/scripts，返回可移植路径。
export async function writeTaskScript(paths, input) {
  const scriptPath = input.scriptPath
    ? resolvePortablePath(paths, input.scriptPath, { label: '脚本保存路径' })
    : path.join(paths.scriptsRoot, 'tasks', `${Date.now()}-${sanitizeFileName(input.name || 'task')}.js`);
  assertInsidePath(paths.scriptsRoot, scriptPath, '脚本保存路径');
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, input.scriptContent, 'utf8');
  return toPortablePath(paths, scriptPath);
}

export function normalizeTaskPaths(paths, input) {
  if (!input.scriptPath || typeof input.scriptPath !== 'string') {
    throw new AppError('INVALID_SCRIPT_PATH', '脚本路径不能为空');
  }
  input.scriptPath = toPortablePath(paths, resolvePortablePath(paths, input.scriptPath, { label: '脚本路径' }), { label: '脚本路径' });
  if (input.cwd) {
    input.cwd = toPortablePath(paths, resolvePortablePath(paths, input.cwd, { label: '工作目录' }), { label: '工作目录' });
  }
}

function sanitizeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'task';
}

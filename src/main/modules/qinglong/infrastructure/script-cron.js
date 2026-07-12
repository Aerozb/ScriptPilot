import path from 'node:path';

/*
 * 从脚本文件头部注释中提取青龙式 cron 声明与任务名。
 * 支持：`cron "0 8 * * *" 名称`、`cron: 0 8 * * *`、`@cron 0 8 * * *` 等写法。
 */

export function extractScriptCron(content) {
  const text = String(content || '').split(/\r?\n/).slice(0, 160).join('\n');
  const quotedMatch = text.match(/^\s*(?:\/\/|\/\*|\*|#)?\s*cron\s+["']([^"']+)["'](?:\s+([^,\s]+))?(?:.*?tag[:：]\s*([^\r\n]+))?/im);
  if (quotedMatch) {
    const cron = normalizeScriptCron(quotedMatch[1]);
    if (cron) {
      return {
        cron,
        rawCron: quotedMatch[1],
        name: normalizeTaskName(quotedMatch[3]) || normalizeTaskName(quotedMatch[2])
      };
    }
  }

  for (const pattern of [
    /^\s*(?:\/\/|\/\*|\*|#)?\s*@?cron\s*[:=]\s*([^\r\n]+)/im,
    /^\s*(?:\/\/|\/\*|\*|#)?\s*@cron\s+([^\r\n]+)/im
  ]) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = match[1].trim();
    const cron = normalizeScriptCron(raw);
    if (cron) return { cron, rawCron: raw };
  }

  return undefined;
}

export function createTaskNameFromScriptPath(scriptPath) {
  return normalizeTaskName(path.posix.basename(String(scriptPath || ''))) || '订阅脚本任务';
}

// 只保留合法 cron 字符的字段；6 段（含秒）则取后 5 段。
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

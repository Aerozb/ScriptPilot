// cron 匹配、校验与未来执行时间预估（与后端调度语义保持一致，0/7 都表示周日）。
import { formatDateTime } from './utils.js';

export function cronPartMatches(part, value, min, max) {
  if (part === '*') return true;
  if (part.includes('/')) {
    const [base, stepRaw] = part.split('/');
    const step = Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return false;
    const baseMatches = base === '*' || cronPartMatches(base, value, min, max);
    return baseMatches && (value - min) % step === 0;
  }
  if (part.includes(',')) return part.split(',').some((item) => cronPartMatches(item, value, min, max));
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(Number);
    return value >= start && value <= end;
  }
  return Number(part) === value;
}

export function cronMatchesDate(parts, date) {
  const day = date.getDay();
  return cronPartMatches(parts[0], date.getMinutes(), 0, 59) &&
    cronPartMatches(parts[1], date.getHours(), 0, 23) &&
    cronPartMatches(parts[2], date.getDate(), 1, 31) &&
    cronPartMatches(parts[3], date.getMonth() + 1, 1, 12) &&
    (cronPartMatches(parts[4], day, 0, 6) || cronPartMatches(parts[4], day || 7, 1, 7));
}

export function isValidCronExpressionText(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.every((part, index) => isValidCronField(part, ranges[index][0], ranges[index][1]));
}

function isValidCronField(field, min, max) {
  return field.split(',').every((segment) => {
    const match = segment.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!match) return false;
    if (match[4] !== undefined && Number(match[4]) === 0) return false;
    if (match[2] !== undefined) {
      const start = Number(match[2]);
      const end = match[3] !== undefined ? Number(match[3]) : start;
      if (start < min || end > max || start > end) return false;
    }
    return true;
  });
}

// 预估下次运行最多要扫描 1440 分钟，按“表达式+当前分钟”缓存，避免每次渲染重复计算。
const nextRunCache = new Map();

export function estimateNextRun(cron) {
  if (!cron) return '-';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return '-';
  const now = new Date();
  const minuteKey = Math.floor(now.getTime() / 60000);
  const cached = nextRunCache.get(cron);
  if (cached?.minuteKey === minuteKey) return cached.text;

  let text = '24 小时后';
  for (let i = 1; i <= 1440; i += 1) {
    const next = new Date(now.getTime() + i * 60 * 1000);
    next.setSeconds(0, 0);
    if (cronMatchesDate(parts, next)) {
      text = formatDateTime(next.toISOString());
      break;
    }
  }
  if (nextRunCache.size > 500) nextRunCache.clear();
  nextRunCache.set(cron, { minuteKey, text });
  return text;
}

// 最多向后扫描 60 天，返回多条规则合并后的前 count 次执行时间。
export function findUpcomingRuns(expressions, count) {
  const results = [];
  if (!expressions.length) return results;
  const parsed = expressions.map((item) => ({ ...item, parts: item.expr.trim().split(/\s+/) }));
  const start = new Date();
  start.setSeconds(0, 0);
  const maxMinutes = 60 * 24 * 60;
  for (let i = 1; i <= maxMinutes && results.length < count; i += 1) {
    const next = new Date(start.getTime() + i * 60 * 1000);
    for (const item of parsed) {
      if (cronMatchesDate(item.parts, next)) {
        results.push({ date: next, label: item.label });
        break;
      }
    }
  }
  return results;
}

export function formatRelativeTime(date) {
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (diffMinutes < 1) return '即将执行';
  if (diffMinutes < 60) return `${diffMinutes} 分钟后`;
  if (diffMinutes < 60 * 24) {
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    return minutes ? `${hours} 小时 ${minutes} 分后` : `${hours} 小时后`;
  }
  const days = Math.floor(diffMinutes / (60 * 24));
  const hours = Math.round((diffMinutes % (60 * 24)) / 60);
  return hours ? `${days} 天 ${hours} 小时后` : `${days} 天后`;
}

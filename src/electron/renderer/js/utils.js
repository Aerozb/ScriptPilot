// 纯工具函数：格式化、转义、表单读取。
import { els } from './context.js';

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function keepExistingSelection(selection, ids) {
  const idSet = new Set(ids);
  return new Set([...selection].filter((id) => idSet.has(id)));
}

export function toggleSet(set, value, selected) {
  if (selected) set.add(value);
  else set.delete(value);
}

export function readValue(id) {
  return els[id].value.trim();
}

export function readLines(id) {
  return els[id].value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function readInteger(id, fallback) {
  const value = Number(els[id].value);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function readBoundedInteger(id, min, max, fallback) {
  const value = Number(els[id].value);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readJsonObject(id, label) {
  const raw = els[id].value.trim();
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value;
}

export function formatStatus(status) {
  const map = {
    running: '运行中',
    success: '成功',
    failed: '失败',
    timeout: '超时',
    stopped: '已停止'
  };
  return map[status] || status || '-';
}

export function statusTagClass(status) {
  const map = {
    running: 'blue',
    success: 'green',
    failed: 'red',
    timeout: 'amber',
    stopped: 'gray'
  };
  return map[status] || 'gray';
}

export function formatTrigger(trigger) {
  const map = {
    manual: '手动',
    api: '接口',
    schedule: '定时',
    subscription: '订阅'
  };
  return map[trigger] || trigger || '-';
}

export function formatDuration(durationMs) {
  if (durationMs === undefined || durationMs === null) return '-';
  if (durationMs < 1000) return `${durationMs} 毫秒`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${restSeconds} 秒`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

export function formatDateTime(value) {
  if (!value) return '-';
  return dateTimeFormatter.format(new Date(value));
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatStartupStatus(status) {
  if (!status.supported) return status.message || '当前系统不支持开机启动';
  const prefix = status.enabled ? '已启用' : '未启用';
  const runLevel = status.runLevel ? `，权限: ${status.runLevel}` : '';
  const execute = status.execute ? `，程序: ${status.execute}` : '';
  return `${prefix}${runLevel}${execute}。${status.message || ''}`;
}

export function formatError(error) {
  return [
    `错误码: ${error.code || 'UNKNOWN'}`,
    `错误信息: ${error.message}`,
    error.details ? `详细信息: ${JSON.stringify(error.details, null, 2)}` : undefined
  ].filter(Boolean).join('\n');
}

export function maskValue(value) {
  const text = String(value || '');
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}••••${text.slice(-4)}`;
}

export function actionName(action) {
  return action === 'remove' ? '卸载' : '安装';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

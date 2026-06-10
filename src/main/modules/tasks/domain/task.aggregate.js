import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors/app-error.js';

export class Task {
  constructor(props) {
    this.id = props.id;
    this.name = props.name;
    this.scriptPath = props.scriptPath;
    this.cwd = props.cwd || undefined;
    this.args = props.args || [];
    this.params = props.params || undefined;
    this.dependencies = props.dependencies || [];
    this.cronExpression = props.cronExpression || undefined;
    this.extraSchedules = props.extraSchedules || [];
    this.labels = props.labels || [];
    this.allowMultipleInstances = props.allowMultipleInstances ?? false;
    this.logName = props.logName || undefined;
    this.beforeScript = props.beforeScript || undefined;
    this.afterScript = props.afterScript || undefined;
    this.remark = props.remark || undefined;
    this.pinned = props.pinned ?? false;
    this.enabled = props.enabled ?? true;
    this.timeoutMs = props.timeoutMs || 0;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(input, now = new Date()) {
    validateTaskInput(input);
    const timestamp = now.toISOString();

    return new Task({
      id: randomUUID(),
      name: input.name.trim(),
      scriptPath: input.scriptPath,
      cwd: input.cwd,
      args: input.args || [],
      params: input.params,
      dependencies: input.dependencies || [],
      cronExpression: normalizeOptionalText(input.cronExpression),
      extraSchedules: normalizeStringArray(input.extraSchedules),
      labels: normalizeStringArray(input.labels),
      allowMultipleInstances: Boolean(input.allowMultipleInstances),
      logName: normalizeOptionalText(input.logName),
      beforeScript: normalizeOptionalText(input.beforeScript),
      afterScript: normalizeOptionalText(input.afterScript),
      remark: normalizeOptionalText(input.remark),
      pinned: Boolean(input.pinned),
      enabled: input.enabled ?? true,
      timeoutMs: input.timeoutMs || 0,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  static fromRecord(record) {
    return new Task(record);
  }

  update(input, now = new Date()) {
    validateTaskInput(input);
    this.name = input.name.trim();
    this.scriptPath = input.scriptPath;
    this.cwd = input.cwd;
    this.args = input.args || [];
    this.params = input.params;
    this.dependencies = input.dependencies || [];
    this.cronExpression = normalizeOptionalText(input.cronExpression);
    this.extraSchedules = normalizeStringArray(input.extraSchedules);
    this.labels = normalizeStringArray(input.labels);
    this.allowMultipleInstances = Boolean(input.allowMultipleInstances);
    this.logName = normalizeOptionalText(input.logName);
    this.beforeScript = normalizeOptionalText(input.beforeScript);
    this.afterScript = normalizeOptionalText(input.afterScript);
    this.remark = normalizeOptionalText(input.remark);
    this.enabled = input.enabled ?? this.enabled;
    this.timeoutMs = input.timeoutMs || 0;
    this.updatedAt = now.toISOString();
  }

  setEnabled(enabled, now = new Date()) {
    this.enabled = Boolean(enabled);
    this.updatedAt = now.toISOString();
  }

  setPinned(pinned, now = new Date()) {
    this.pinned = Boolean(pinned);
    this.updatedAt = now.toISOString();
  }

  addLabels(labels, now = new Date()) {
    this.labels = [...new Set([...(this.labels || []), ...normalizeStringArray(labels)])];
    this.updatedAt = now.toISOString();
  }

  removeLabels(labels, now = new Date()) {
    const removing = new Set(normalizeStringArray(labels));
    this.labels = (this.labels || []).filter((label) => !removing.has(label));
    this.updatedAt = now.toISOString();
  }

  toRecord() {
    return {
      id: this.id,
      name: this.name,
      scriptPath: this.scriptPath,
      cwd: this.cwd,
      args: this.args,
      params: this.params,
      dependencies: this.dependencies,
      cronExpression: this.cronExpression,
      extraSchedules: this.extraSchedules,
      labels: this.labels,
      allowMultipleInstances: this.allowMultipleInstances,
      logName: this.logName,
      beforeScript: this.beforeScript,
      afterScript: this.afterScript,
      remark: this.remark,
      pinned: this.pinned,
      enabled: this.enabled,
      timeoutMs: this.timeoutMs,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

function validateTaskInput(input) {
  if (!input || typeof input !== 'object') {
    throw new AppError('INVALID_TASK_INPUT', '任务输入必须是对象');
  }

  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
    throw new AppError('INVALID_TASK_NAME', '任务名称不能为空');
  }

  if (!input.scriptPath || typeof input.scriptPath !== 'string') {
    throw new AppError('INVALID_SCRIPT_PATH', '脚本路径不能为空');
  }

  if (input.args !== undefined && !Array.isArray(input.args)) {
    throw new AppError('INVALID_TASK_ARGS', '任务参数 args 必须是数组');
  }

  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0)) {
    throw new AppError('INVALID_TIMEOUT', '任务超时时间 timeoutMs 必须是非负整数');
  }

  if (input.params !== undefined && (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params))) {
    throw new AppError('INVALID_TASK_PARAMS', '任务结构化参数 params 必须是 JSON 对象');
  }

  if (input.dependencies !== undefined && !Array.isArray(input.dependencies)) {
    throw new AppError('INVALID_TASK_DEPENDENCIES', '任务依赖 dependencies 必须是数组');
  }

  if (input.extraSchedules !== undefined && !Array.isArray(input.extraSchedules)) {
    throw new AppError('INVALID_EXTRA_SCHEDULES', '额外定时规则 extraSchedules 必须是数组');
  }

  if (input.labels !== undefined && !Array.isArray(input.labels)) {
    throw new AppError('INVALID_TASK_LABELS', '任务标签 labels 必须是数组');
  }
}

function normalizeOptionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
    : [];
}

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SETTINGS = {
  appearance: {
    theme: 'light',
    density: 'comfortable',
    fontScale: 100,
    radius: 18,
    accent: 'emerald',
    fontFamily: 'Microsoft YaHei UI'
  },
  crontab: {
    activeViewId: 'all',
    pageSize: 20,
    sort: {
      field: 'pinned',
      direction: 'DESC'
    },
    views: []
  },
  logCleanup: {
    enabled: true,
    retentionDays: 30,
    intervalDays: 3,
    lastCleanedAt: undefined
  }
};

export class JsonSettingsRepository {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async get() {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      return mergeSettings(DEFAULT_SETTINGS, data);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async save(input) {
    const current = await this.get();
    const next = mergeSettings(current, input);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }
}

function mergeSettings(base, input) {
  const appearance = input?.appearance || {};
  return {
    appearance: {
      theme: normalizeEnum(appearance.theme, ['light', 'dark'], base.appearance.theme),
      density: normalizeEnum(appearance.density, ['compact', 'comfortable', 'spacious'], base.appearance.density),
      fontScale: clampInteger(appearance.fontScale, 90, 120, base.appearance.fontScale),
      radius: clampInteger(appearance.radius, 10, 28, base.appearance.radius),
      accent: normalizeEnum(appearance.accent, ['emerald', 'blue', 'orange', 'slate'], base.appearance.accent),
      fontFamily: normalizeEnum(appearance.fontFamily, [
        'Microsoft YaHei UI',
        'DengXian',
        'Microsoft JhengHei UI',
        'Noto Sans SC'
      ], base.appearance.fontFamily)
    },
    crontab: {
      activeViewId: normalizeText(input?.crontab?.activeViewId, base.crontab.activeViewId),
      pageSize: clampInteger(input?.crontab?.pageSize, 10, 500, base.crontab.pageSize),
      sort: normalizeSort(input?.crontab?.sort, base.crontab.sort),
      views: normalizeViews(input?.crontab?.views, base.crontab.views)
    },
    logCleanup: {
      enabled: input?.logCleanup?.enabled === undefined ? base.logCleanup.enabled : Boolean(input.logCleanup.enabled),
      retentionDays: clampInteger(input?.logCleanup?.retentionDays, 1, 3650, base.logCleanup.retentionDays),
      intervalDays: clampInteger(input?.logCleanup?.intervalDays, 1, 365, base.logCleanup.intervalDays),
      lastCleanedAt: normalizeOptionalIsoDate(input?.logCleanup?.lastCleanedAt, base.logCleanup.lastCleanedAt)
    }
  };
}

function normalizeEnum(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeOptionalIsoDate(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizeSort(value, fallback) {
  const allowedFields = ['name', 'scriptPath', 'status', 'cronExpression', 'lastDuration', 'lastStartedAt', 'nextRunAt', 'updatedAt', 'pinned'];
  const field = allowedFields.includes(value?.field) ? value.field : fallback.field;
  const direction = normalizeEnum(value?.direction, ['ASC', 'DESC'], fallback.direction);
  return { field, direction };
}

function normalizeViews(value, fallback) {
  if (!Array.isArray(value)) return fallback || [];
  return value
    .filter((view) => view && typeof view === 'object')
    .map((view) => ({
      id: normalizeText(view.id, `view-${Date.now()}`),
      name: normalizeText(view.name, '未命名视图'),
      disabled: Boolean(view.disabled),
      filterRelation: normalizeEnum(view.filterRelation, ['and', 'or'], 'and'),
      filters: normalizeViewRules(view.filters),
      sorts: normalizeViewRules(view.sorts)
    }))
    .slice(0, 50);
}

function normalizeViewRules(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      property: normalizeText(rule.property, 'name'),
      operation: normalizeText(rule.operation, 'Reg'),
      value: Array.isArray(rule.value)
        ? rule.value.map((item) => String(item).trim()).filter(Boolean)
        : normalizeText(rule.value, '')
    }))
    .filter((rule) => rule.property);
}

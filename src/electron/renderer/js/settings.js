// 系统设置页：外观、任务表格偏好（视图/排序/分页）、日志清理、开机启动。
import { api, els, state } from './context.js';
import { formatDateTime, formatError, formatStartupStatus, readBoundedInteger, readInteger } from './utils.js';
import { toast } from './ui.js';
import { refreshRuns } from './runs.js';

let logCleanupSaveTimer;
let logCleanupSaveSeq = 0;

export function bindSettings() {
  els.enableStartupButton.addEventListener('click', () => updateStartup(() => api.enableStartup()));
  els.disableStartupButton.addEventListener('click', () => updateStartup(() => api.disableStartup()));
  els.cleanupLogsNowButton.addEventListener('click', cleanupLogsNow);
  els.saveAppearanceButton.addEventListener('click', saveAppearanceSettings);
  ['logCleanupEnabledInput', 'logRetentionDaysInput', 'logCleanupIntervalDaysInput'].forEach((id) => {
    els[id].addEventListener(id === 'logCleanupEnabledInput' ? 'change' : 'input', scheduleLogCleanupAutoSave);
  });
  ['themeSelect', 'densitySelect', 'fontFamilySelect', 'accentSelect', 'fontScaleInput', 'radiusInput'].forEach((id) => {
    els[id].addEventListener('input', () => {
      const settings = readAppearanceForm();
      applyAppearance(settings.appearance);
      updateAppearanceLabels(settings.appearance);
      els.appearanceStatus.textContent = '外观已预览，点击保存后持久化';
    });
  });
}

export async function refreshStartupStatus() {
  try {
    const status = await api.getStartupStatus();
    els.startupStatus.textContent = formatStartupStatus(status);
  } catch (error) {
    els.startupStatus.textContent = formatError(error);
  }
}

async function updateStartup(action) {
  els.startupStatus.textContent = '正在操作开机启动...';
  try {
    const result = await action();
    els.startupStatus.textContent = formatStartupStatus(result);
  } catch (error) {
    els.startupStatus.textContent = formatError(error);
  }
}

export async function loadAppearanceSettings() {
  const settings = await api.getSettings();
  applySettings(settings);
}

async function saveAppearanceSettings() {
  try {
    const settings = mergeSettings({
      appearance: readAppearanceForm().appearance
    });
    const saved = await api.saveSettings(settings);
    applySettings(saved);
    els.appearanceStatus.textContent = '外观设置已保存到 data/state/settings.json';
  } catch (error) {
    els.appearanceStatus.textContent = formatError(error);
  }
}

export function applySettings(settings) {
  state.settings = settings || {};
  fillAppearanceForm(state.settings.appearance);
  applyAppearance(state.settings.appearance);
  updateAppearanceLabels(state.settings.appearance);
  applyCrontabSettings(state.settings.crontab);
  fillLogCleanupForm(state.settings.logCleanup);
  updateLogCleanupStatus(state.settings.logCleanup);
}

function mergeSettings(patch = {}) {
  return {
    ...(state.settings || {}),
    ...patch,
    appearance: {
      ...(state.settings?.appearance || {}),
      ...(patch.appearance || {})
    },
    crontab: {
      ...(state.settings?.crontab || {}),
      ...(patch.crontab || {})
    },
    logCleanup: {
      ...(state.settings?.logCleanup || {}),
      ...(patch.logCleanup || {})
    }
  };
}

function scheduleLogCleanupAutoSave() {
  clearTimeout(logCleanupSaveTimer);
  const saveSeq = ++logCleanupSaveSeq;
  const form = readLogCleanupForm();
  updateLogCleanupStatus({
    ...(state.settings?.logCleanup || {}),
    ...form.logCleanup
  });

  logCleanupSaveTimer = setTimeout(() => {
    saveLogCleanupSettingsNow(form, saveSeq).catch((error) => {
      toast(formatError(error));
      updateLogCleanupStatus(state.settings?.logCleanup);
    });
  }, 450);
}

async function saveLogCleanupSettingsNow(form = readLogCleanupForm(), saveSeq = ++logCleanupSaveSeq) {
  const saved = await api.saveSettings(mergeSettings(form));
  if (saveSeq !== logCleanupSaveSeq) return;
  state.settings = saved || {};
  fillLogCleanupForm(state.settings.logCleanup);
  updateLogCleanupStatus(state.settings.logCleanup);
  toast('日志清理配置已自动保存');
}

async function cleanupLogsNow() {
  els.cleanupLogsNowButton.disabled = true;
  toast('正在清理旧日志...');
  try {
    const result = await api.cleanupLogsNow();
    const settings = await api.getSettings();
    applySettings(settings);
    toast(`已清理 ${result.deletedRuns || 0} 条运行记录、${result.deletedLogFiles || 0} 个日志文件`);
    await refreshRuns();
  } catch (error) {
    toast(formatError(error));
  } finally {
    els.cleanupLogsNowButton.disabled = false;
  }
}

function fillLogCleanupForm(logCleanup = {}) {
  els.logCleanupEnabledInput.checked = logCleanup.enabled !== false;
  els.logRetentionDaysInput.value = String(logCleanup.retentionDays || 30);
  els.logCleanupIntervalDaysInput.value = String(logCleanup.intervalDays || 3);
}

function readLogCleanupForm() {
  return {
    logCleanup: {
      enabled: els.logCleanupEnabledInput.checked,
      retentionDays: readBoundedInteger('logRetentionDaysInput', 1, 3650, 30),
      intervalDays: readBoundedInteger('logCleanupIntervalDaysInput', 1, 365, 3),
      lastCleanedAt: state.settings?.logCleanup?.lastCleanedAt
    }
  };
}

function updateLogCleanupStatus(logCleanup = {}) {
  els.logCleanupStatus.textContent = logCleanup.lastCleanedAt
    ? `上次清理：${formatDateTime(logCleanup.lastCleanedAt)}`
    : '上次清理：尚未清理';
}

function applyCrontabSettings(crontab = {}) {
  const normalized = {
    activeViewId: crontab.activeViewId || 'all',
    pageSize: Number(crontab.pageSize) || 20,
    sort: crontab.sort || { field: 'pinned', direction: 'DESC' },
    views: Array.isArray(crontab.views) ? crontab.views : []
  };
  state.settings = {
    ...(state.settings || {}),
    crontab: normalized
  };
  state.taskPageSize = normalized.pageSize;
  state.taskSort = normalized.sort;
  els.taskPageSizeInput.value = String(normalized.pageSize);
}

export function getCrontabViews() {
  return Array.isArray(state.settings?.crontab?.views) ? state.settings.crontab.views : [];
}

export async function saveCrontabSettings(patch = {}) {
  const nextCrontab = {
    ...(state.settings?.crontab || {}),
    activeViewId: state.settings?.crontab?.activeViewId || 'all',
    pageSize: state.taskPageSize,
    sort: state.taskSort,
    views: getCrontabViews(),
    ...patch
  };
  const saved = await api.saveSettings(mergeSettings({ crontab: nextCrontab }));
  state.settings = saved;
  state.taskPageSize = saved.crontab.pageSize;
  state.taskSort = saved.crontab.sort;
  els.taskPageSizeInput.value = String(saved.crontab.pageSize);
}

function fillAppearanceForm(appearance) {
  els.themeSelect.value = appearance.theme;
  els.densitySelect.value = appearance.density;
  els.fontFamilySelect.value = appearance.fontFamily;
  els.accentSelect.value = appearance.accent;
  els.fontScaleInput.value = String(appearance.fontScale);
  els.radiusInput.value = String(appearance.radius);
}

function readAppearanceForm() {
  return {
    appearance: {
      theme: els.themeSelect.value,
      density: els.densitySelect.value,
      fontFamily: els.fontFamilySelect.value,
      accent: els.accentSelect.value,
      fontScale: readInteger('fontScaleInput', 100),
      radius: readInteger('radiusInput', 18)
    }
  };
}

function applyAppearance(appearance) {
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.density = appearance.density;
  document.documentElement.dataset.accent = appearance.accent;
  document.documentElement.style.setProperty('--font-scale', `${appearance.fontScale}%`);
  document.documentElement.style.setProperty('--radius-base', `${appearance.radius}px`);
  document.documentElement.style.setProperty('--app-font', `"${appearance.fontFamily}", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`);
}

function updateAppearanceLabels(appearance) {
  els.fontScaleValue.textContent = `${appearance.fontScale}%`;
  els.radiusValue.textContent = String(appearance.radius);
}

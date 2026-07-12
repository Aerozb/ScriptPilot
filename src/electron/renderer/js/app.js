// 应用入口：页面导航、全局刷新、启动引导。
import { api, bindElements, els, state } from './context.js';
import { formatError } from './utils.js';
import { bindConfirmModal, renderMetrics, showFatalError, toast } from './ui.js';
import { refreshQinglongData, refreshTasksAndRuns } from './data.js';
import { bindTasks, renderTasks } from './tasks.js';
import { bindTaskModal } from './task-modal.js';
import { bindEnvs, renderEnvs } from './envs.js';
import { bindSubscriptions, refreshSubscriptions, renderSubscriptions } from './subscriptions.js';
import { bindConfigs, refreshConfigs, renderConfigs } from './configs.js';
import { bindScripts, refreshScripts, renderScripts } from './scripts.js';
import { bindDependencies, refreshDependencies, renderDependencies } from './dependencies.js';
import { bindRuns, refreshRuns, renderRuns } from './runs.js';
import { bindSettings, loadAppearanceSettings, refreshStartupStatus } from './settings.js';

const pageMeta = {
  crontab: ['定时任务', '青龙式任务表格，支持批量运行、启停、删除和查看日志。'],
  subscription: ['订阅管理', '拉取 GitHub 仓库、GitHub Raw 或普通 HTTP 脚本到本地 data/scripts，并查看订阅运行日志。'],
  env: ['环境变量', '保存脚本运行所需变量，支持批量启用、禁用和删除。'],
  config: ['配置文件', '编辑 data/configs 下的配置文件，所有内容留在安装目录。'],
  script: ['脚本管理', '管理 data/scripts 下的脚本文件，可直接保存、运行和删除。'],
  dependence: ['依赖管理', '查看和安装 npm 依赖，依赖统一写入 data/node_modules。'],
  log: ['日志管理', '查看任务、API、手动运行和订阅拉取产生的日志。'],
  setting: ['系统设置', '绿色目录、开机启动、外观和对外接口。']
};

// 切换页面时按需刷新的数据源。
const pageRefreshers = {
  script: refreshScripts,
  config: refreshConfigs,
  log: refreshRuns,
  dependence: refreshDependencies,
  subscription: refreshSubscriptions
};

document.addEventListener('DOMContentLoaded', () => {
  bindElements();
  bindGlobalEvents();
  bindConfirmModal();
  bindTasks();
  bindTaskModal();
  bindEnvs();
  bindSubscriptions();
  bindConfigs();
  bindScripts();
  bindDependencies();
  bindRuns();
  bindSettings();
  init().catch(showFatalError);
});

function bindGlobalEvents() {
  document.querySelectorAll('.menu-item').forEach((button) => {
    button.addEventListener('click', () => showPage(button.dataset.page));
  });

  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  });

  els.refreshAllButton.addEventListener('click', () => refreshAll());
  els.openDataButton.addEventListener('click', () => api.openDataDir());
}

async function init() {
  state.info = await api.getInfo();
  els.portableRoot.textContent = state.info.portableRoot;
  els.dataRoot.textContent = state.info.dataRoot;
  els.runtimeRoot.textContent = state.info.runtimeRoot;
  els.apiUrl.textContent = state.info.apiUrl || '未启动';
  els.sideApiUrl.textContent = state.info.apiUrl || '未启动';
  // 单个模块的数据异常只提示，不中断整个界面。
  await loadAppearanceSettings().catch((error) => toast(formatError(error)));
  await showPage(state.activePage || 'crontab');
  await Promise.all([
    refreshAll().catch((error) => toast(formatError(error))),
    refreshStartupStatus()
  ]);
}

export async function showPage(pageName) {
  state.activePage = pageName;
  document.querySelectorAll('.menu-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.id === pageName);
  });
  const meta = pageMeta[pageName] || pageMeta.crontab;
  els.pageTitle.textContent = meta[0];
  els.pageSubtitle.textContent = meta[1];
  try {
    await pageRefreshers[pageName]?.();
  } catch (error) {
    toast(formatError(error));
  }
}

export async function refreshAll() {
  // 一半数据出错时仍渲染成功的部分，错误继续向上抛给调用方提示。
  const results = await Promise.allSettled([
    refreshTasksAndRuns(),
    refreshQinglongData()
  ]);
  renderAll();
  const firstError = results.find((result) => result.status === 'rejected');
  if (firstError) throw firstError.reason;
}

function renderAll() {
  renderMetrics();
  renderTasks();
  renderEnvs();
  renderSubscriptions();
  renderConfigs();
  renderScripts();
  renderDependencies();
  renderRuns();
}

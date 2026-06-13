const api = window.scriptPilot;
const SCRIPT_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const TASK_SORT_FALLBACK = { field: 'pinned', direction: 'DESC' };
const TASK_SORTABLE_FIELDS = new Set(['name', 'cronExpression', 'lastDuration', 'lastStartedAt', 'nextRunAt', 'pinned']);

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

const state = {
  info: undefined,
  tasks: [],
  runs: [],
  overview: undefined,
  envs: [],
  configs: [],
  scripts: [],
  scriptTree: undefined,
  subscriptions: [],
  dependencies: [],
  dependencyHistory: [],
  installingDependency: false,
  selectedTaskIds: new Set(),
  selectedEnvIds: new Set(),
  selectedSubscriptionIds: new Set(),
  selectedScriptPaths: new Set(),
  taskFormScriptPaths: [],
  taskScriptPickerSelectedPaths: new Set(),
  taskScriptPickerExpandedDirs: new Set(['data/scripts']),
  taskScriptPickerVisibleTree: undefined,
  taskScriptPickerLastKeyword: '',
  taskScriptPickerMulti: true,
  taskMutatingIds: new Set(),
  launchingTaskIds: new Set(),
  launchingScriptPaths: new Set(),
  runningSubscriptionIds: new Set(),
  expandedScriptDirs: new Set(['data/scripts']),
  settings: undefined,
  taskPage: 1,
  taskPageSize: 20,
  taskSort: { field: 'pinned', direction: 'DESC' },
  taskRows: [],
  taskFilteredTotal: 0,
  currentConfigName: '',
  currentScriptPath: '',
  currentRunId: '',
  currentTaskLogRunId: '',
  currentTaskLogTaskId: '',
  currentSubscriptionLogRunId: '',
  completedSubscriptionRunRefreshIds: new Set(),
  activePage: 'crontab'
};

const els = {};
const htmlCache = new WeakMap();
let pendingConfirmResolver;
let logCleanupSaveTimer;
let logCleanupSaveSeq = 0;
let scriptSplitResize;
let logRefreshTimer;
let taskLogRefreshTimer;
let subscriptionLogRefreshTimer;
let taskScriptPickerRenderFrame;
let envRenderFrame;

document.addEventListener('DOMContentLoaded', () => {
  bindElements();
  bindEvents();
  initScriptSplitResize();
  init().catch(showFatalError);
});

function bindElements() {
  for (const node of document.querySelectorAll('[id]')) {
    els[node.id] = node;
  }
}

function setHtml(element, html) {
  if (!element || htmlCache.get(element) === html) return false;
  htmlCache.set(element, html);
  element.innerHTML = html;
  return true;
}

function bindEvents() {
  document.querySelectorAll('.menu-item').forEach((button) => {
    button.addEventListener('click', () => showPage(button.dataset.page));
  });

  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  });

  els.refreshAllButton.addEventListener('click', () => refreshAll());
  els.openDataButton.addEventListener('click', () => api.openDataDir());
  els.quickRunButton.addEventListener('click', () => openRunModal());

  els.newTaskButton.addEventListener('click', () => openTaskModal());
  els.taskForm.addEventListener('submit', handleTaskSubmit);
  els.taskSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      state.taskPage = 1;
      renderTasks();
    }
  });
  els.taskSearchButton.addEventListener('click', () => {
    state.taskPage = 1;
    renderTasks();
  });
  els.taskResetSearchButton.addEventListener('click', () => {
    els.taskSearchInput.value = '';
    state.taskPage = 1;
    renderTasks();
  });
  els.batchRunTasksButton.addEventListener('click', () => batchRunTasks());
  els.batchStopTasksButton.addEventListener('click', () => batchStopTasks());
  els.batchEnableTasksButton.addEventListener('click', () => batchSetTasksEnabled(true));
  els.batchDisableTasksButton.addEventListener('click', () => batchSetTasksEnabled(false));
  els.batchPinTasksButton.addEventListener('click', () => batchSetTasksPinned(true));
  els.batchUnpinTasksButton.addEventListener('click', () => batchSetTasksPinned(false));
  els.batchLabelsButton.addEventListener('click', () => openLabelModal());
  els.taskViewTabs.addEventListener('click', handleTaskViewTabsClick);
  els.viewManageButton.addEventListener('click', () => showViewManager());
  els.batchDeleteTasksButton.addEventListener('click', () => batchDeleteTasks());
  els.taskTable.addEventListener('click', handleTaskTableClick);
  els.taskTable.addEventListener('change', handleTaskTableChange);
  els.taskTable.addEventListener('dblclick', handleTaskTableDblClick);
  els.taskPageSizeInput.addEventListener('change', async () => {
    state.taskPageSize = Number(els.taskPageSizeInput.value) || 20;
    state.taskPage = 1;
    await saveCrontabSettings();
    renderTasks();
  });
  els.taskPrevPageButton.addEventListener('click', () => {
    if (state.taskPage > 1) {
      state.taskPage -= 1;
      renderTasks();
    }
  });
  els.taskNextPageButton.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.taskFilteredTotal / state.taskPageSize));
    if (state.taskPage < totalPages) {
      state.taskPage += 1;
      renderTasks();
    }
  });
  els.taskScriptSourceInput.addEventListener('change', () => syncTaskScriptSourceFields());
  els.taskScriptPathInput.addEventListener('click', () => {
    if (els.taskScriptSourceInput.value === 'existing') openTaskScriptPicker();
  });
  els.chooseTaskScriptButton.addEventListener('click', () => openTaskScriptPicker());
  els.taskScriptPickerSearchInput.addEventListener('input', () => scheduleTaskScriptPickerRender());
  els.taskScriptPickerList.addEventListener('click', handleTaskScriptPickerClick);
  els.taskScriptPickerList.addEventListener('change', handleTaskScriptPickerChange);
  els.clearTaskScriptPickerButton.addEventListener('click', () => {
    state.taskScriptPickerSelectedPaths.clear();
    renderTaskScriptPicker();
  });
  els.confirmTaskScriptPickerButton.addEventListener('click', () => confirmTaskScriptPicker());
  els.taskScheduleTypeInput.addEventListener('change', () => syncScheduleTypeFields());
  els.labelForm.addEventListener('submit', handleLabelSubmit);
  els.removeLabelsButton.addEventListener('click', () => updateSelectedLabels('remove'));
  els.viewForm.addEventListener('submit', handleViewSubmit);
  els.createViewButton.addEventListener('click', () => openViewModal());
  els.viewManageTable.addEventListener('click', handleViewManageClick);

  els.runForm.addEventListener('submit', handleRunSubmit);

  els.newEnvButton.addEventListener('click', () => openEnvModal());
  els.envForm.addEventListener('submit', handleEnvSubmit);
  els.envSearchInput.addEventListener('input', () => scheduleEnvRender());
  els.envTable.addEventListener('click', handleEnvTableClick);
  els.envTable.addEventListener('change', handleEnvTableChange);
  els.batchEnableEnvsButton.addEventListener('click', () => batchSetEnvsStatus('enabled'));
  els.batchDisableEnvsButton.addEventListener('click', () => batchSetEnvsStatus('disabled'));
  els.batchDeleteEnvsButton.addEventListener('click', () => batchDeleteEnvs());

  els.newSubscriptionButton.addEventListener('click', () => openSubscriptionModal());
  els.subscriptionForm.addEventListener('submit', handleSubscriptionSubmit);
  els.subscriptionTable.addEventListener('click', handleSubscriptionTableClick);
  els.subscriptionTable.addEventListener('change', handleSubscriptionTableChange);
  els.batchRunSubscriptionsButton.addEventListener('click', () => batchRunSubscriptions());
  els.batchDeleteSubscriptionsButton.addEventListener('click', () => batchDeleteSubscriptions());

  els.refreshConfigsButton.addEventListener('click', () => refreshConfigs());
  els.openConfigsDirButton.addEventListener('click', () => openPortableDirectory('data/configs'));
  els.openCurrentConfigDirButton.addEventListener('click', () => openCurrentConfigDirectory());
  els.saveConfigButton.addEventListener('click', () => saveCurrentConfig());
  els.configList.addEventListener('click', handleConfigListClick);

  els.newScriptButton.addEventListener('click', () => newScript());
  els.openScriptsDirButton.addEventListener('click', () => openPortableDirectory('data/scripts'));
  els.openCurrentScriptDirButton.addEventListener('click', () => openCurrentScriptDirectory());
  els.saveScriptButton.addEventListener('click', () => saveCurrentScript());
  els.runScriptFileButton.addEventListener('click', () => runCurrentScript());
  els.deleteScriptButton.addEventListener('click', () => deleteCurrentScript());
  els.selectAllScriptsInput.addEventListener('change', () => toggleAllScripts(els.selectAllScriptsInput.checked));
  els.scriptList.addEventListener('click', handleScriptListClick);
  els.scriptList.addEventListener('change', handleScriptListChange);
  els.batchRunScriptsButton.addEventListener('click', () => batchRunScripts());
  els.batchDeleteScriptsButton.addEventListener('click', () => batchDeleteScripts());
  els.clearScriptSelectionButton.addEventListener('click', () => clearScriptSelection());
  els.confirmCancelButton.addEventListener('click', () => resolveConfirm(false));
  els.confirmOkButton.addEventListener('click', () => resolveConfirm(true));
  els.confirmModal.addEventListener('cancel', (event) => {
    event.preventDefault();
    resolveConfirm(false);
  });

  els.installDependencyButton.addEventListener('click', () => installDependency());
  els.dependencyNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') installDependency();
  });
  els.dependencyTable.addEventListener('click', handleDependencyTableClick);

  els.refreshRunsButton.addEventListener('click', () => refreshRuns());
  els.runList.addEventListener('click', handleRunListClick);
  els.copyLogButton.addEventListener('click', () => copyCurrentLog());
  els.copyTaskLogButton.addEventListener('click', () => copyTaskLog());
  els.openTaskLogPageButton.addEventListener('click', () => openCurrentTaskLogPage());
  els.taskLogModal.addEventListener('close', () => stopTaskLogRefresh());
  els.copySubscriptionLogButton.addEventListener('click', () => copySubscriptionLog());
  els.openSubscriptionLogPageButton.addEventListener('click', () => openCurrentSubscriptionLogPage());
  els.subscriptionLogModal.addEventListener('close', () => stopSubscriptionLogRefresh());

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

function initScriptSplitResize() {
  if (!els.scriptSplit || !els.scriptSplitResizer) return;
  const savedWidth = Number(localStorage.getItem('scriptPilot.scriptListWidth'));
  if (Number.isFinite(savedWidth) && savedWidth >= 220) {
    setScriptListWidth(savedWidth);
  }

  els.scriptSplitResizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const rect = els.scriptSplit.getBoundingClientRect();
    scriptSplitResize = {
      pointerId: event.pointerId,
      left: rect.left,
      width: rect.width
    };
    els.scriptSplitResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-script-list');
  });

  els.scriptSplitResizer.addEventListener('pointermove', (event) => {
    if (!scriptSplitResize || scriptSplitResize.pointerId !== event.pointerId) return;
    const nextWidth = clamp(event.clientX - scriptSplitResize.left, 220, Math.min(620, scriptSplitResize.width - 360));
    setScriptListWidth(nextWidth);
  });

  const finishResize = (event) => {
    if (!scriptSplitResize || scriptSplitResize.pointerId !== event.pointerId) return;
    const width = Number.parseInt(getComputedStyle(els.scriptSplit).getPropertyValue('--script-list-width'), 10);
    if (Number.isFinite(width)) localStorage.setItem('scriptPilot.scriptListWidth', String(width));
    scriptSplitResize = undefined;
    document.body.classList.remove('resizing-script-list');
  };
  els.scriptSplitResizer.addEventListener('pointerup', finishResize);
  els.scriptSplitResizer.addEventListener('pointercancel', finishResize);
}

function setScriptListWidth(width) {
  els.scriptSplit.style.setProperty('--script-list-width', `${Math.round(width)}px`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function init() {
  state.info = await api.getInfo();
  els.portableRoot.textContent = state.info.portableRoot;
  els.dataRoot.textContent = state.info.dataRoot;
  els.runtimeRoot.textContent = state.info.runtimeRoot;
  els.apiUrl.textContent = state.info.apiUrl || '未启动';
  els.sideApiUrl.textContent = state.info.apiUrl || '未启动';
  await loadAppearanceSettings();
  activatePage(state.activePage || 'crontab');
  await Promise.all([
    refreshAll(),
    refreshStartupStatus()
  ]);
}

async function refreshAll() {
  await Promise.all([
    refreshTasksAndRuns(),
    refreshQinglongData()
  ]);
  renderAll();
}

async function refreshTasksAndRuns() {
  const [tasks, runs] = await Promise.all([
    api.listTasks(),
    api.listRuns({ limit: 200 })
  ]);
  state.tasks = tasks.items || [];
  state.runs = runs.items || [];
}

async function refreshTasksOnly() {
  const tasks = await api.listTasks();
  state.tasks = tasks.items || [];
}

async function refreshQinglongData() {
  const [overview, envs, configs, scripts, subscriptions, dependencies] = await Promise.all([
    api.qlOverview(),
    api.listEnvs(),
    api.listConfigs(),
    api.listScripts(),
    api.listSubscriptions(),
    api.listDependencies()
  ]);
  state.overview = overview;
  state.envs = envs.items || [];
  state.configs = configs.items || [];
  state.scripts = scripts.items || [];
  state.scriptTree = undefined;
  state.subscriptions = subscriptions.items || [];
  state.dependencies = dependencies.items || [];
  state.dependencyHistory = dependencies.history || [];
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

async function showPage(pageName) {
  activatePage(pageName);
  await refreshActivePage(pageName);
}

function activatePage(pageName) {
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
}

async function refreshActivePage(pageName) {
  try {
    if (pageName === 'crontab') await refreshCrontabPage();
    else if (pageName === 'script') await refreshScripts();
    else if (pageName === 'config') await refreshConfigs();
    else if (pageName === 'log') await refreshRuns();
    else if (pageName === 'dependence') await refreshDependencies();
    else if (pageName === 'subscription') await refreshSubscriptions();
  } catch (error) {
    toast(formatError(error));
  }
}

async function refreshCrontabPage() {
  await refreshTasksAndRuns();
  renderMetrics();
  renderTasks();
}

function confirmAction(options) {
  if (pendingConfirmResolver) {
    resolveConfirm(false);
  }

  const tone = options?.tone === 'danger' ? 'danger' : 'normal';
  els.confirmTitle.textContent = options?.title || '请确认操作';
  els.confirmMessage.textContent = options?.message || '确认继续吗？';
  els.confirmIcon.textContent = tone === 'danger' ? '!' : '?';
  els.confirmIcon.classList.toggle('danger', tone === 'danger');
  els.confirmOkButton.textContent = options?.okText || '确定';
  els.confirmCancelButton.textContent = options?.cancelText || '取消';
  els.confirmOkButton.classList.toggle('danger', tone === 'danger');
  els.confirmOkButton.classList.toggle('primary', tone !== 'danger');
  if (options?.details) {
    els.confirmDetails.hidden = false;
    els.confirmDetails.textContent = options.details;
  } else {
    els.confirmDetails.hidden = true;
    els.confirmDetails.textContent = '';
  }
  els.confirmModal.showModal();
  els.confirmOkButton.focus();

  return new Promise((resolve) => {
    pendingConfirmResolver = resolve;
  });
}

function resolveConfirm(value) {
  if (els.confirmModal.open) els.confirmModal.close();
  const resolver = pendingConfirmResolver;
  pendingConfirmResolver = undefined;
  resolver?.(value);
}

function renderMetrics() {
  if (els.metricTaskCount) els.metricTaskCount.textContent = String(state.tasks.length);
  if (els.metricRunCount) els.metricRunCount.textContent = String(state.runs.length);
  const enabledEnvCount = state.envs.filter((item) => item.status === 'enabled').length;
  if (els.metricEnvCount) els.metricEnvCount.textContent = `${enabledEnvCount}/${state.envs.length}`;
  if (els.metricScriptCount) els.metricScriptCount.textContent = String(state.scripts.length);
}

function renderTasks() {
  const keyword = els.taskSearchInput.value.trim().toLowerCase();
  state.selectedTaskIds = keepExistingSelection(state.selectedTaskIds, state.tasks.map((item) => item.id));
  renderTaskViews();

  const rows = sortTaskRows(state.tasks
    .map((task) => enrichTask(task))
    .filter((task) => taskMatchesKeyword(task, keyword))
    .filter((task) => taskMatchesActiveView(task)));
  state.taskFilteredTotal = rows.length;
  const totalPages = Math.max(1, Math.ceil(rows.length / state.taskPageSize));
  if (state.taskPage > totalPages) state.taskPage = totalPages;
  const start = (state.taskPage - 1) * state.taskPageSize;
  const pageRows = rows.slice(start, start + state.taskPageSize);
  state.taskRows = pageRows;
  const allSelected = pageRows.length > 0 && pageRows.every((task) => state.selectedTaskIds.has(task.id));
  renderTaskPagination(rows.length, pageRows.length);

  if (!pageRows.length) {
    setHtml(els.taskTable, `<div class="empty">暂无定时任务，点击“新建任务”创建第一个脚本任务。</div>`);
    updateTaskButtons();
    return;
  }

  setHtml(els.taskTable, `
    <table class="data-table ql-cron-table">
      <thead>
        <tr>
          <th class="check-col"><input id="selectAllTasksInput" type="checkbox" ${allSelected ? 'checked' : ''}></th>
          <th style="width: 150px">${renderSortHeader('name', '名称')}</th>
          <th style="width: 260px">命令/脚本</th>
          <th style="width: 108px">状态</th>
          <th style="width: 146px">${renderSortHeader('cronExpression', '定时规则')}</th>
          <th style="width: 132px">${renderSortHeader('lastDuration', '最后运行时长')}</th>
          <th style="width: 160px">${renderSortHeader('lastStartedAt', '最后运行时间')}</th>
          <th style="width: 160px">${renderSortHeader('nextRunAt', '下次运行时间')}</th>
          <th style="width: 150px">标签</th>
          <th style="width: 138px">操作</th>
        </tr>
      </thead>
      <tbody>
        ${pageRows.map((task) => renderTaskRow(task)).join('')}
      </tbody>
    </table>
  `);

  updateTaskButtons();
}

function renderTaskRow(task) {
  const selected = state.selectedTaskIds.has(task.id);
  const isMutating = state.taskMutatingIds.has(task.id);
  const rowClass = [selected ? 'selected' : '', task.pinned ? 'pinned-row' : '', isMutating ? 'mutating-row' : ''].filter(Boolean).join(' ');
  const displayScriptPath = formatTaskScriptPath(task.scriptPath);
  const status = isMutating
    ? { value: 'mutating', label: '处理中', className: 'amber' }
    : task.statusInfo;
  const isLaunching = state.launchingTaskIds.has(task.id);
  const isBusy = isLaunching || task.statusInfo.value === 'running';
  return `
    <tr class="${rowClass}" data-task-row="${escapeAttr(task.id)}">
      <td class="check-col"><input type="checkbox" data-task-check="${escapeAttr(task.id)}" ${selected ? 'checked' : ''}></td>
      <td class="name-col" title="${escapeAttr(task.name)}"><button class="link-button name-link" data-detail-task="${escapeAttr(task.id)}">${task.pinned ? '<span class="pin-text">置顶</span>' : ''}${escapeHtml(task.name)}</button></td>
      <td class="path-col" title="${escapeAttr(task.scriptPath)}"><button class="link-button path-link" data-open-task-script="${escapeAttr(task.id)}">${escapeHtml(displayScriptPath)}</button></td>
      <td>
        <span class="tag ${status.className}">${escapeHtml(status.label)}</span>
      </td>
      <td class="mono" title="${escapeAttr(formatScheduleTitle(task))}">${escapeHtml(formatSchedule(task))}</td>
      <td>${escapeHtml(task.latestRun ? formatDuration(task.latestRun.durationMs) : '-')}</td>
      <td>${escapeHtml(task.latestRun ? formatDateTime(task.latestRun.startedAt) : '-')}</td>
      <td>${escapeHtml(task.nextRunText)}</td>
      <td>${renderLabels(task.labels)}</td>
      <td>
        <div class="row-actions">
          ${isBusy ? `<button class="link-button red" data-stop-task="${escapeAttr(task.id)}">${isLaunching ? '启动中' : '停止'}</button>` : `<button class="link-button" data-run-task="${escapeAttr(task.id)}" ${isMutating ? 'disabled' : ''}>运行</button>`}
          <button class="link-button" data-log-task="${escapeAttr(task.id)}" ${task.latestRun ? '' : 'disabled'}>日志</button>
          <button class="link-button menu-trigger" data-more-task="${escapeAttr(task.id)}" ${isMutating ? 'disabled' : ''}>更多</button>
        </div>
      </td>
    </tr>
  `;
}

function handleTaskTableClick(event) {
  const sortButton = event.target.closest('[data-task-sort]');
  if (sortButton) {
    event.stopPropagation();
    changeTaskSort(sortButton.dataset.taskSort);
    return;
  }

  const detailButton = event.target.closest('[data-detail-task]');
  if (detailButton) {
    event.stopPropagation();
    openTaskDetail(detailButton.dataset.detailTask);
    return;
  }

  const scriptButton = event.target.closest('[data-open-task-script]');
  if (scriptButton) {
    event.stopPropagation();
    openTaskScript(scriptButton.dataset.openTaskScript);
    return;
  }

  const runButton = event.target.closest('[data-run-task]');
  if (runButton) {
    event.stopPropagation();
    runTask(runButton.dataset.runTask);
    return;
  }

  const stopButton = event.target.closest('[data-stop-task]');
  if (stopButton) {
    event.stopPropagation();
    stopTask(stopButton.dataset.stopTask);
    return;
  }

  const logButton = event.target.closest('[data-log-task]');
  if (logButton) {
    event.stopPropagation();
    showTaskLog(logButton.dataset.logTask);
    return;
  }

  const moreButton = event.target.closest('[data-more-task]');
  if (moreButton) {
    event.stopPropagation();
    openTaskMoreMenu(moreButton.dataset.moreTask, moreButton);
    return;
  }

  const row = event.target.closest('[data-task-row]');
  if (row && !event.target.closest('button,input')) {
    const id = row.dataset.taskRow;
    toggleSet(state.selectedTaskIds, id, !state.selectedTaskIds.has(id));
    renderTasks();
  }
}

function handleTaskTableChange(event) {
  if (event.target.id === 'selectAllTasksInput') {
    state.taskRows.forEach((task) => toggleSet(state.selectedTaskIds, task.id, event.target.checked));
    renderTasks();
    return;
  }

  const checkbox = event.target.closest('[data-task-check]');
  if (checkbox) {
    toggleSet(state.selectedTaskIds, checkbox.dataset.taskCheck, checkbox.checked);
    renderTasks();
  }
}

function handleTaskTableDblClick(event) {
  const row = event.target.closest('[data-task-row]');
  if (row && !event.target.closest('button,input')) {
    openTaskDetail(row.dataset.taskRow);
  }
}

function enrichTask(task) {
  const latestRun = latestRunForTask(task.id);
  const statusInfo = getTaskStatus(task, latestRun);
  const nextRunText = formatNextRun(task);
  return {
    ...task,
    latestRun,
    statusInfo,
    nextRunText,
    nextRunAt: parseDisplayDate(nextRunText)
  };
}

function getTaskStatus(task, latestRun) {
  if (!task.enabled && latestRun?.status !== 'running') {
    return { value: 'disabled', label: '已禁用', className: 'red' };
  }

  if (latestRun?.status === 'running') {
    return { value: 'running', label: '运行中', className: 'blue' };
  }

  if (latestRun?.status === 'queued') {
    return { value: 'queued', label: '队列中', className: 'amber' };
  }

  return { value: 'idle', label: '空闲中', className: '' };
}

function taskMatchesKeyword(task, keyword) {
  if (!keyword) return true;
  return [
    task.name,
    task.scriptPath,
    task.cronExpression,
    task.remark,
    task.statusInfo.label,
    ...(task.labels || [])
  ].join(' ').toLowerCase().includes(keyword);
}

function taskMatchesActiveView(task) {
  const view = getActiveTaskView();
  if (!view || view.id === 'all') return true;
  const filters = Array.isArray(view.filters) ? view.filters : [];
  if (!filters.length) return true;
  const matches = filters.map((filter) => taskMatchesViewFilter(task, filter));
  return view.filterRelation === 'or' ? matches.some(Boolean) : matches.every(Boolean);
}

function taskMatchesViewFilter(task, filter) {
  const values = Array.isArray(filter.value) ? filter.value : [filter.value].filter(Boolean);
  if (!values.length) return true;
  const actual = getTaskFilterText(task, filter.property);
  const hit = values.some((value) => actual.includes(String(value).toLowerCase()));
  if (filter.operation === 'NotReg' || filter.operation === 'Nin') return !hit;
  return hit;
}

function getTaskFilterText(task, property) {
  if (property === 'status') return task.statusInfo.value;
  if (property === 'labels') return (task.labels || []).join('\n').toLowerCase();
  if (property === 'scriptPath') return String(task.scriptPath || '').toLowerCase();
  if (property === 'cronExpression') return String(task.cronExpression || '').toLowerCase();
  return String(task.name || '').toLowerCase();
}

function sortTaskRows(rows) {
  const { field, direction } = normalizeTaskSort(state.taskSort);
  const factor = direction === 'ASC' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned && field !== 'pinned') return a.pinned ? -1 : 1;
    const result = compareTaskField(a, b, field);
    if (result !== 0) return result * factor;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function normalizeTaskSort(sort) {
  if (!sort || !TASK_SORTABLE_FIELDS.has(sort.field)) return { ...TASK_SORT_FALLBACK };
  return {
    field: sort.field,
    direction: sort.direction === 'ASC' ? 'ASC' : 'DESC'
  };
}

function compareTaskField(a, b, field) {
  if (field === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  if (field === 'cronExpression') return String(a.cronExpression || '').localeCompare(String(b.cronExpression || ''), 'zh-CN');
  if (field === 'lastDuration') return Number(a.latestRun?.durationMs || 0) - Number(b.latestRun?.durationMs || 0);
  if (field === 'lastStartedAt') return new Date(a.latestRun?.startedAt || 0).getTime() - new Date(b.latestRun?.startedAt || 0).getTime();
  if (field === 'nextRunAt') return Number(a.nextRunAt || 0) - Number(b.nextRunAt || 0);
  if (field === 'pinned') return Number(a.pinned) - Number(b.pinned);
  return new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
}

function renderSortHeader(field, label) {
  const active = state.taskSort?.field === field;
  const mark = active ? (state.taskSort.direction === 'ASC' ? '↑' : '↓') : '↕';
  const title = active
    ? `${label}，当前${state.taskSort.direction === 'ASC' ? '升序' : '降序'}，点击切换排序`
    : `${label}，点击排序`;
  return `<button class="sort-button ${active ? 'active' : ''}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" data-task-sort="${escapeAttr(field)}"><span>${escapeHtml(label)}</span><span class="sort-icon" aria-hidden="true">${mark}</span></button>`;
}

async function changeTaskSort(field) {
  if (!TASK_SORTABLE_FIELDS.has(field)) return;
  const direction = state.taskSort?.field === field && state.taskSort.direction === 'ASC' ? 'DESC' : 'ASC';
  state.taskSort = { field, direction };
  await saveCrontabSettings();
  renderTasks();
}

function formatTaskScriptPath(scriptPath) {
  const normalized = String(scriptPath || '').replaceAll('\\', '/');
  if (normalized.startsWith('data/scripts/')) return normalized.slice('data/scripts/'.length) || normalized;
  return normalized || '-';
}

function renderTaskPagination(total, currentCount) {
  const from = total === 0 ? 0 : (state.taskPage - 1) * state.taskPageSize + 1;
  const to = total === 0 ? 0 : from + currentCount - 1;
  const totalPages = Math.max(1, Math.ceil(total / state.taskPageSize));
  els.taskPaginationInfo.textContent = `第 ${from}-${to} 条，总共 ${total} 条`;
  els.taskPrevPageButton.disabled = state.taskPage <= 1;
  els.taskNextPageButton.disabled = state.taskPage >= totalPages;
}

function renderTaskViews() {
  const views = getVisibleTaskViews();
  const activeId = getActiveTaskView()?.id || 'all';
  setHtml(els.taskViewTabs, views.map((view) => `
    <button class="view-tab ${view.id === activeId ? 'active' : ''}" data-task-view="${escapeAttr(view.id)}">${escapeHtml(view.name)}</button>
  `).join(''));
}

async function handleTaskViewTabsClick(event) {
  const button = event.target.closest('[data-task-view]');
  if (!button) return;
  state.selectedTaskIds.clear();
  state.taskPage = 1;
  await saveCrontabSettings({ activeViewId: button.dataset.taskView });
  renderTasks();
}

function getCrontabViews() {
  return Array.isArray(state.settings?.crontab?.views) ? state.settings.crontab.views : [];
}

function getVisibleTaskViews() {
  return [{ id: 'all', name: '全部任务', type: 'system', disabled: false }, ...getCrontabViews().filter((view) => !view.disabled)];
}

function getActiveTaskView() {
  const activeId = state.settings?.crontab?.activeViewId || 'all';
  return getVisibleTaskViews().find((view) => view.id === activeId) || getVisibleTaskViews()[0];
}

function parseDisplayDate(text) {
  if (!text || text === '-' || text === '仅手动' || text === '下次开机' || text === '24 小时后') return 0;
  const time = new Date(text.replace(/\//g, '-')).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function updateTaskButtons() {
  const count = state.selectedTaskIds.size;
  els.taskSelectionText.textContent = `已选择 ${count} 项`;
  els.taskBatchBar.hidden = count === 0;
  [
    els.batchRunTasksButton,
    els.batchStopTasksButton,
    els.batchEnableTasksButton,
    els.batchDisableTasksButton,
    els.batchPinTasksButton,
    els.batchUnpinTasksButton,
    els.batchLabelsButton,
    els.batchDeleteTasksButton
  ].forEach((button) => {
    button.disabled = count === 0;
  });
}

async function handleTaskSubmit(event) {
  event.preventDefault();
  try {
    const input = readTaskForm();
    const scriptPaths = input.scriptPaths || [];
    delete input.scriptPaths;
    if (input.taskId) {
      await api.updateTask(input);
    } else if (scriptPaths.length > 1) {
      for (const scriptPath of scriptPaths) {
        await api.createTask({
          ...input,
          name: createTaskNameForScript(input.name, scriptPath, scriptPaths.length),
          scriptPath,
          scriptContent: undefined
        });
      }
    } else {
      if (scriptPaths.length === 1) input.scriptPath = scriptPaths[0];
      await api.createTask(input);
    }
    els.taskModal.close();
    await refreshTasksAndRuns();
    renderMetrics();
    renderTasks();
    toast(input.taskId ? '任务已更新' : scriptPaths.length > 1 ? `已创建 ${scriptPaths.length} 个任务` : '任务已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

function readTaskForm() {
  const scheduleType = els.taskScheduleTypeInput.value;
  const source = els.taskScriptSourceInput.value;
  const scriptPaths = source === 'existing' ? normalizeSelectedTaskScriptPaths() : [];
  if (source === 'existing' && !scriptPaths.length) {
    throw new Error('请选择至少一个已有脚本，或切换为“填写新脚本内容”');
  }
  const scriptContent = source === 'inline' ? readValue('taskScriptContentInput') : '';
  if (source === 'inline' && !scriptContent) {
    throw new Error('请填写脚本内容，或切换为“选择已有脚本”');
  }

  return {
    taskId: els.taskIdInput.value || undefined,
    name: readValue('taskNameInput'),
    scriptPath: source === 'inline' ? readValue('taskScriptPathInput') || undefined : scriptPaths[0],
    scriptPaths,
    scriptContent: scriptContent || undefined,
    cronExpression: scheduleType === 'boot' ? '@boot' : scheduleType === 'once' ? '@once' : readValue('taskCronInput') || undefined,
    cwd: readValue('taskCwdInput') || 'data',
    args: readLines('taskArgsInput'),
    params: readJsonObject('taskParamsInput', '结构化参数 JSON'),
    dependencies: readLines('taskDependenciesInput'),
    extraSchedules: readLines('taskExtraSchedulesInput'),
    labels: readLines('taskLabelsInput'),
    allowMultipleInstances: els.taskInstanceModeInput.value === 'multiple',
    logName: readValue('taskLogNameInput') || undefined,
    beforeScript: readValue('taskBeforeInput') || undefined,
    afterScript: readValue('taskAfterInput') || undefined,
    remark: readValue('taskRemarkInput') || undefined,
    enabled: els.taskEnabledInput.checked,
    timeoutMs: readInteger('taskTimeoutInput', 30000)
  };
}

function openTaskModal(task, options = {}) {
  els.taskForm.reset();
  const cloneMode = options.clone === true;
  const isEdit = Boolean(task?.id && !cloneMode);
  els.taskModalTitle.textContent = isEdit ? '编辑任务' : cloneMode ? '复制任务' : '新建定时任务';
  els.taskIdInput.value = isEdit ? task.id : '';
  els.taskNameInput.value = cloneMode ? `${task.name} - 副本` : task?.name || '我的脚本任务';
  state.taskFormScriptPaths = cloneMode ? [] : task?.scriptPath ? [task.scriptPath] : [];
  state.taskScriptPickerMulti = !isEdit;
  els.taskScriptSourceInput.value = task?.scriptContent ? 'inline' : 'existing';
  const scheduleType = task?.cronExpression === '@once' ? 'once' : task?.cronExpression === '@boot' ? 'boot' : 'normal';
  els.taskScheduleTypeInput.value = scheduleType;
  els.taskCronInput.value = scheduleType === 'normal' ? task?.cronExpression || '*/5 * * * *' : '';
  els.taskInstanceModeInput.value = task?.allowMultipleInstances ? 'multiple' : 'single';
  updateTaskScriptPathInput();
  els.taskScriptContentInput.value = task?.scriptContent || defaultTaskScript();
  els.taskArgsInput.value = (task?.args || []).join('\n');
  els.taskParamsInput.value = JSON.stringify(task?.params || { 来源: '定时任务' }, null, 2);
  els.taskCwdInput.value = task?.cwd || 'data';
  els.taskTimeoutInput.value = String(task?.timeoutMs ?? 30000);
  els.taskExtraSchedulesInput.value = (task?.extraSchedules || []).join('\n');
  els.taskLabelsInput.value = (task?.labels || []).join('\n');
  els.taskDependenciesInput.value = (task?.dependencies || []).join('\n');
  els.taskLogNameInput.value = task?.logName || '';
  els.taskRemarkInput.value = task?.remark || '';
  els.taskBeforeInput.value = task?.beforeScript || '';
  els.taskAfterInput.value = task?.afterScript || '';
  els.taskEnabledInput.checked = task?.enabled ?? true;
  syncScheduleTypeFields();
  syncTaskScriptSourceFields();
  els.taskModal.showModal();
  els.taskNameInput.focus();
}

function defaultTaskScript() {
  return [
    'const params = JSON.parse(process.env.SCRIPTPILOT_PARAMS || "{}");',
    'console.log("定时任务执行成功");',
    'console.log(JSON.stringify({ args: process.argv.slice(2), params, trigger: process.env.SCRIPTPILOT_TRIGGER }));'
  ].join('\n');
}

function syncScheduleTypeFields() {
  const isNormal = els.taskScheduleTypeInput.value === 'normal';
  els.taskCronInput.disabled = !isNormal;
  els.taskExtraSchedulesInput.disabled = !isNormal;
}

function syncTaskScriptSourceFields() {
  const source = els.taskScriptSourceInput.value;
  const isExisting = source === 'existing';
  els.chooseTaskScriptButton.hidden = !isExisting;
  els.taskScriptPathInput.readOnly = isExisting;
  els.taskScriptPathLabel.textContent = isExisting ? '脚本路径' : '保存路径，可留空';
  els.taskScriptPathInput.placeholder = isExisting
    ? '点击选择 data/scripts 下的脚本，可多选批量创建任务'
    : '留空自动保存到 data/scripts/tasks，也可填 data/scripts/custom.js';
  els.taskScriptPathHint.textContent = isExisting
    ? '选择已有脚本时，只保存路径，不会写入脚本内容；多选会批量创建任务。'
    : '填写新脚本内容时，会写入新脚本文件；如果填写保存路径，将写入该路径。';
  els.taskScriptContentField.hidden = isExisting;
  if (!isExisting) {
    state.taskFormScriptPaths = [];
    updateTaskScriptPathInput();
  }
}

function normalizeSelectedTaskScriptPaths() {
  if (state.taskFormScriptPaths.length) return state.taskFormScriptPaths;
  return readValue('taskScriptPathInput')
    .split(/\r?\n|;|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function updateTaskScriptPathInput() {
  els.taskScriptPathInput.value = state.taskFormScriptPaths.join('\n');
  if (els.taskScriptSourceInput?.value === 'existing') {
    const count = state.taskFormScriptPaths.length;
    els.taskScriptPathHint.textContent = count > 1
      ? `已选择 ${count} 个脚本，保存后会批量创建 ${count} 个任务。`
      : '选择已有脚本时，只保存路径，不会写入脚本内容；多选会批量创建任务。';
  }
}

function createTaskNameForScript(baseName, scriptPath, count) {
  const scriptName = scriptPath.split('/').pop()?.replace(/\.(cjs|mjs|js)$/i, '') || '脚本任务';
  const trimmed = String(baseName || '').trim();
  if (!trimmed || trimmed === '我的脚本任务' || count > 1) return scriptName;
  return trimmed;
}

async function openTaskScriptPicker() {
  if (els.taskScriptSourceInput.value !== 'existing') return;
  try {
    if (!state.scripts.length) {
      const scripts = await api.listScripts();
      state.scripts = scripts.items || [];
      state.scriptTree = undefined;
    }
    state.taskScriptPickerSelectedPaths = new Set(state.taskFormScriptPaths);
    state.taskScriptPickerExpandedDirs = new Set(['data/scripts']);
    state.taskScriptPickerVisibleTree = undefined;
    state.taskScriptPickerLastKeyword = '';
    state.taskFormScriptPaths.forEach((scriptPath) => expandScriptParents(scriptPath, state.taskScriptPickerExpandedDirs));
    els.taskScriptPickerSearchInput.value = '';
    els.taskScriptPickerTitle.textContent = state.taskScriptPickerMulti ? '选择脚本' : '选择一个脚本';
    els.taskScriptPickerHint.textContent = state.taskScriptPickerMulti
      ? '可多选脚本，保存后会为每个脚本创建一个任务。'
      : '编辑任务时只能选择一个脚本。';
    renderTaskScriptPicker();
    els.taskScriptPickerModal.showModal();
    els.taskScriptPickerSearchInput.focus();
  } catch (error) {
    toast(formatError(error));
  }
}

function renderTaskScriptPicker() {
  const keyword = els.taskScriptPickerSearchInput.value.trim().toLowerCase();
  const keywordChanged = keyword !== state.taskScriptPickerLastKeyword;
  state.taskScriptPickerLastKeyword = keyword;
  const rows = state.scripts
    .filter((item) => SCRIPT_FILE_EXTENSIONS.some((ext) => item.path.toLowerCase().endsWith(ext)))
    .filter((item) => {
      if (!keyword) return true;
      return item.path.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword);
    });

  els.taskScriptPickerSelectionText.textContent = `已选择 ${state.taskScriptPickerSelectedPaths.size} 个脚本`;
  els.clearTaskScriptPickerButton.disabled = state.taskScriptPickerSelectedPaths.size === 0;
  els.confirmTaskScriptPickerButton.disabled = state.taskScriptPickerSelectedPaths.size === 0;
  if (!rows.length) {
    state.taskScriptPickerVisibleTree = undefined;
    setHtml(els.taskScriptPickerList, '<div class="empty">暂无可选脚本，请先在脚本管理或订阅管理中保存脚本。</div>');
    return;
  }

  const tree = buildScriptTree(rows);
  state.taskScriptPickerVisibleTree = tree;
  if (keyword && keywordChanged) {
    for (const dirPath of collectScriptDirPaths(tree)) {
      state.taskScriptPickerExpandedDirs.add(dirPath);
    }
  }
  const expandedDirs = state.taskScriptPickerExpandedDirs;
  syncVisibleScriptDirectories(tree, expandedDirs);
  setHtml(els.taskScriptPickerList, `<div class="script-tree script-picker-tree">${renderTaskScriptPickerTreeChildren(tree, 0, expandedDirs)}</div>`);
  els.taskScriptPickerList.querySelectorAll('[data-task-script-picker-dir-check]').forEach((checkbox) => {
    checkbox.indeterminate = checkbox.dataset.indeterminate === 'true';
  });
}

function confirmTaskScriptPicker() {
  const selected = [...state.taskScriptPickerSelectedPaths];
  if (!selected.length) {
    toast('请先选择脚本');
    return;
  }
  state.taskFormScriptPaths = state.taskScriptPickerMulti ? selected : selected.slice(0, 1);
  updateTaskScriptPathInput();
  els.taskScriptPickerModal.close();
}

function scheduleTaskScriptPickerRender() {
  if (taskScriptPickerRenderFrame) cancelAnimationFrame(taskScriptPickerRenderFrame);
  taskScriptPickerRenderFrame = requestAnimationFrame(() => {
    taskScriptPickerRenderFrame = undefined;
    renderTaskScriptPicker();
  });
}

function renderTaskScriptPickerTreeChildren(node, depth, expandedDirs) {
  const dirs = [...node.dirs.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].toSorted((a, b) => a.name.localeCompare(b.name));
  return [
    ...dirs.map((dir) => renderTaskScriptPickerDirectory(dir, depth, expandedDirs)),
    ...files.map((file) => renderTaskScriptPickerFile(file, depth))
  ].join('');
}

function renderTaskScriptPickerDirectory(node, depth, expandedDirs) {
  const expanded = expandedDirs.has(node.path);
  const paths = collectScriptPaths(node);
  const selectedCount = paths.filter((scriptPath) => state.taskScriptPickerSelectedPaths.has(scriptPath)).length;
  const checked = paths.length > 0 && selectedCount === paths.length;
  const indeterminate = selectedCount > 0 && !checked;
  return `
    <div class="script-tree-node">
      <div class="script-tree-row script-tree-dir" style="--depth:${depth}" data-task-script-picker-dir-row="${escapeAttr(node.path)}">
        <button class="script-tree-toggle" type="button" data-task-script-picker-dir-toggle="${escapeAttr(node.path)}">${expanded ? '▾' : '▸'}</button>
        <input type="checkbox" data-task-script-picker-dir-check="${escapeAttr(node.path)}" data-indeterminate="${indeterminate}" ${checked ? 'checked' : ''} ${state.taskScriptPickerMulti ? '' : 'disabled'}>
        <span class="script-tree-name">
          <strong>${escapeHtml(node.name)}</strong>
          <small>${paths.length} 个脚本</small>
        </span>
      </div>
      ${expanded ? `<div class="script-tree-children">${renderTaskScriptPickerTreeChildren(node, depth + 1, expandedDirs)}</div>` : ''}
    </div>
  `;
}

function renderTaskScriptPickerFile(item, depth) {
  const selected = state.taskScriptPickerSelectedPaths.has(item.path);
  const inputType = state.taskScriptPickerMulti ? 'checkbox' : 'radio';
  return `
    <div class="file-item script-file-item ${selected ? 'selected' : ''}" style="--depth:${depth}" data-task-script-picker-file-row="${escapeAttr(item.path)}">
      <input type="${inputType}" name="taskScriptPickerFile" data-task-script-picker-file="${escapeAttr(item.path)}" ${selected ? 'checked' : ''}>
      <span class="script-file-meta">
        <strong title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.path)}</small>
      </span>
      <span class="script-file-size">${escapeHtml(formatBytes(item.size))}</span>
    </div>
  `;
}

function handleTaskScriptPickerClick(event) {
  const toggle = event.target.closest('[data-task-script-picker-dir-toggle]');
  if (toggle) {
    event.stopPropagation();
    toggleTaskScriptPickerDirectory(toggle.dataset.taskScriptPickerDirToggle);
    return;
  }

  const dirRow = event.target.closest('[data-task-script-picker-dir-row]');
  if (dirRow && !event.target.closest('input,button')) {
    toggleTaskScriptPickerDirectory(dirRow.dataset.taskScriptPickerDirRow);
    return;
  }

  const fileRow = event.target.closest('[data-task-script-picker-file-row]');
  if (fileRow && !event.target.closest('input')) {
    const scriptPath = fileRow.dataset.taskScriptPickerFileRow;
    setTaskScriptPickerFileSelected(scriptPath, !state.taskScriptPickerSelectedPaths.has(scriptPath));
    renderTaskScriptPicker();
  }
}

function handleTaskScriptPickerChange(event) {
  const fileInput = event.target.closest('[data-task-script-picker-file]');
  if (fileInput) {
    setTaskScriptPickerFileSelected(fileInput.dataset.taskScriptPickerFile, fileInput.checked);
    renderTaskScriptPicker();
    return;
  }

  const dirInput = event.target.closest('[data-task-script-picker-dir-check]');
  if (dirInput) {
    toggleTaskScriptPickerDirectorySelection(dirInput.dataset.taskScriptPickerDirCheck, dirInput.checked);
    renderTaskScriptPicker();
  }
}

function toggleTaskScriptPickerDirectory(dirPath) {
  if (state.taskScriptPickerExpandedDirs.has(dirPath)) state.taskScriptPickerExpandedDirs.delete(dirPath);
  else state.taskScriptPickerExpandedDirs.add(dirPath);
  renderTaskScriptPicker();
}

function setTaskScriptPickerFileSelected(scriptPath, selected) {
  if (selected) {
    if (!state.taskScriptPickerMulti) state.taskScriptPickerSelectedPaths.clear();
    state.taskScriptPickerSelectedPaths.add(scriptPath);
  } else {
    state.taskScriptPickerSelectedPaths.delete(scriptPath);
  }
}

function toggleTaskScriptPickerDirectorySelection(dirPath, checked) {
  if (!state.taskScriptPickerMulti) return;
  const visibleNode = findScriptTreeNode(state.taskScriptPickerVisibleTree, dirPath);
  const paths = visibleNode
    ? collectScriptPaths(visibleNode)
    : state.scripts
      .map((item) => item.path)
      .filter((scriptPath) => scriptPath.startsWith(`${dirPath}/`))
      .filter((scriptPath) => SCRIPT_FILE_EXTENSIONS.some((ext) => scriptPath.toLowerCase().endsWith(ext)));
  for (const scriptPath of paths) {
    setTaskScriptPickerFileSelected(scriptPath, checked);
  }
}

async function runTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (state.launchingTaskIds.has(taskId) || latestRunForTask(taskId)?.status === 'running') {
    toast('该任务正在运行，请在日志页查看实时输出');
    return;
  }
  if (!await confirmAction({
    title: '运行定时任务',
    message: `确认立即运行「${task.name}」吗？`,
    okText: '立即运行'
  })) return;
  state.launchingTaskIds.add(taskId);
  renderTasks();
  toast(`已启动运行: ${task?.name || taskId}`);
  try {
    const result = await api.runTaskNow(taskId, { waitForCompletion: false });
    const runId = result.runId || result.data?.runId;
    await refreshTasksAndRuns();
    renderMetrics();
    renderTasks();
    renderRuns();
    if (state.detailTaskId === taskId && els.taskDetailModal.open) {
      await refreshTaskDetail(taskId);
    }
    if (runId) await openTaskLogModal(runId, taskId);
    toast('任务已开始运行，日志正在实时刷新');
  } catch (error) {
    toast(formatError(error));
  } finally {
    state.launchingTaskIds.delete(taskId);
    renderTasks();
  }
}

async function stopTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (!await confirmAction({
    title: '停止定时任务',
    message: `确认停止「${task.name}」当前运行实例吗？`,
    okText: '停止',
    tone: 'danger'
  })) return;
  try {
    await api.stopTaskRun(taskId);
    await refreshTasksAndRuns();
    renderTasks();
    renderRuns();
    if (state.detailTaskId === taskId && els.taskDetailModal.open) {
      await refreshTaskDetail(taskId);
    }
    toast('任务已停止');
  } catch (error) {
    toast(formatError(error));
  }
}

async function batchRunTasks() {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  if (!await confirmAction({
    title: '批量运行任务',
    message: `确认立即运行选中的 ${ids.length} 个定时任务吗？`,
    okText: '批量运行'
  })) return;
  try {
    ids.forEach((id) => state.launchingTaskIds.add(id));
    renderTasks();
    toast(`正在启动 ${ids.length} 个任务`);
    let lastRunId;
    for (const id of ids) {
      const result = await api.runTaskNow(id, { waitForCompletion: false });
      lastRunId = result.runId || result.data?.runId || lastRunId;
    }
    await refreshTasksAndRuns();
    renderMetrics();
    renderTasks();
    renderRuns();
    if (lastRunId) {
      await openTaskLogModal(lastRunId);
    }
    toast(`已启动 ${ids.length} 个任务，日志正在实时刷新`);
  } catch (error) {
    toast(formatError(error));
  } finally {
    ids.forEach((id) => state.launchingTaskIds.delete(id));
    renderTasks();
  }
}

async function batchStopTasks() {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  if (!await confirmAction({
    title: '批量停止任务',
    message: `确认停止选中的 ${ids.length} 个定时任务吗？`,
    okText: '批量停止',
    tone: 'danger'
  })) return;
  for (const id of ids) await api.stopTaskRun(id);
  await refreshTasksAndRuns();
  renderTasks();
  renderRuns();
  toast(`已停止 ${ids.length} 个任务`);
}

function snapshotTasks(ids) {
  const idSet = new Set(ids);
  return state.tasks.filter((task) => idSet.has(task.id)).map((task) => ({ ...task }));
}

function restoreTaskSnapshots(snapshots) {
  const snapshotMap = new Map(snapshots.map((task) => [task.id, task]));
  state.tasks = state.tasks.map((task) => snapshotMap.get(task.id) || task);
}

function patchTaskRows(ids, patch) {
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  state.tasks = state.tasks.map((task) => idSet.has(task.id)
    ? { ...task, ...patch, updatedAt: now }
    : task);
}

function setTaskMutating(ids, mutating) {
  for (const id of ids) {
    if (mutating) state.taskMutatingIds.add(id);
    else state.taskMutatingIds.delete(id);
  }
}

async function setTaskEnabled(taskId, enabled) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const snapshots = snapshotTasks([taskId]);
  patchTaskRows([taskId], { enabled });
  setTaskMutating([taskId], true);
  renderTasks();
  if (state.detailTaskId === taskId && els.taskDetailModal.open) {
    await refreshTaskDetail(taskId);
  }
  try {
    await api.setTaskEnabled(taskId, enabled);
    setTaskMutating([taskId], false);
    renderTasks();
    if (state.detailTaskId === taskId && els.taskDetailModal.open) {
      await refreshTaskDetail(taskId);
    }
    toast(enabled ? '任务已启用' : '任务已禁用');
  } catch (error) {
    restoreTaskSnapshots(snapshots);
    setTaskMutating([taskId], false);
    renderTasks();
    toast(formatError(error));
  }
}

async function batchSetTasksEnabled(enabled) {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  const snapshots = snapshotTasks(ids);
  patchTaskRows(ids, { enabled });
  setTaskMutating(ids, true);
  renderTasks();
  try {
    if (api.setTasksEnabled) await api.setTasksEnabled(ids, enabled);
    else for (const id of ids) await api.setTaskEnabled(id, enabled);
    setTaskMutating(ids, false);
    renderTasks();
    toast(enabled ? `已启用 ${ids.length} 个任务` : `已禁用 ${ids.length} 个任务`);
  } catch (error) {
    restoreTaskSnapshots(snapshots);
    setTaskMutating(ids, false);
    await refreshTasksOnly().catch(() => undefined);
    renderTasks();
    toast(formatError(error));
  }
}

async function setTaskPinned(taskId, pinned) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const snapshots = snapshotTasks([taskId]);
  patchTaskRows([taskId], { pinned });
  setTaskMutating([taskId], true);
  renderTasks();
  if (state.detailTaskId === taskId && els.taskDetailModal.open) {
    await refreshTaskDetail(taskId);
  }
  try {
    await api.setTaskPinned(taskId, pinned);
    setTaskMutating([taskId], false);
    renderTasks();
    if (state.detailTaskId === taskId && els.taskDetailModal.open) {
      await refreshTaskDetail(taskId);
    }
    toast(pinned ? '任务已置顶' : '已取消置顶');
  } catch (error) {
    restoreTaskSnapshots(snapshots);
    setTaskMutating([taskId], false);
    renderTasks();
    toast(formatError(error));
  }
}

async function batchSetTasksPinned(pinned) {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  const snapshots = snapshotTasks(ids);
  patchTaskRows(ids, { pinned });
  setTaskMutating(ids, true);
  renderTasks();
  try {
    if (api.setTasksPinned) await api.setTasksPinned(ids, pinned);
    else for (const id of ids) await api.setTaskPinned(id, pinned);
    setTaskMutating(ids, false);
    renderTasks();
    toast(pinned ? `已置顶 ${ids.length} 个任务` : `已取消置顶 ${ids.length} 个任务`);
  } catch (error) {
    restoreTaskSnapshots(snapshots);
    setTaskMutating(ids, false);
    await refreshTasksOnly().catch(() => undefined);
    renderTasks();
    toast(formatError(error));
  }
}

async function deleteTask(taskId) {
  if (!await confirmAction({
    title: '删除任务',
    message: '确定删除该任务吗？历史运行记录和日志会保留。',
    okText: '删除',
    tone: 'danger'
  })) return;
  try {
    await api.deleteTask(taskId);
    state.selectedTaskIds.delete(taskId);
    await refreshTasksAndRuns();
    renderMetrics();
    renderTasks();
    toast('任务已删除');
  } catch (error) {
    toast(formatError(error));
  }
}

async function batchDeleteTasks() {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  if (!await confirmAction({
    title: '批量删除任务',
    message: `确定删除选中的 ${ids.length} 个任务吗？历史运行记录和日志会保留。`,
    okText: '批量删除',
    tone: 'danger'
  })) return;
  for (const id of ids) {
    await api.deleteTask(id);
  }
  state.selectedTaskIds.clear();
  await refreshTasksAndRuns();
  renderMetrics();
  renderTasks();
  toast(`已删除 ${ids.length} 个任务`);
}

function openTaskMoreMenu(taskId, anchor) {
  closeFloatingMenu();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const menu = document.createElement('div');
  menu.className = 'floating-menu';
  menu.innerHTML = `
    <button data-menu-action="edit">编辑</button>
    <button data-menu-action="toggle">${task.enabled ? '禁用' : '启用'}</button>
    <button data-menu-action="copy">复制</button>
    <button class="danger-text" data-menu-action="delete">删除</button>
    <button data-menu-action="pin">${task.pinned ? '取消置顶' : '置顶'}</button>
    <button data-menu-action="api">复制 API</button>
    <button data-menu-action="detail">详情</button>
  `;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  menu.querySelectorAll('[data-menu-action]').forEach((button) => button.addEventListener('click', async () => {
    closeFloatingMenu();
    const action = button.dataset.menuAction;
    if (action === 'edit') openTaskModal(task);
    if (action === 'copy') openTaskModal(task, { clone: true });
    if (action === 'toggle') await setTaskEnabled(task.id, !task.enabled);
    if (action === 'pin') await setTaskPinned(task.id, !task.pinned);
    if (action === 'api') await copyTaskApi(task.id);
    if (action === 'detail') await openTaskDetail(task.id);
    if (action === 'delete') await deleteTask(task.id);
  }));
  setTimeout(() => document.addEventListener('click', closeFloatingMenu, { once: true }));
}

function closeFloatingMenu() {
  document.querySelector('.floating-menu')?.remove();
}

async function copyTaskApi(taskId) {
  const url = `${state.info?.apiUrl || 'http://127.0.0.1:18760'}/api/tasks/${taskId}/run`;
  await api.copyText(`POST ${url}\nContent-Type: application/json\n\n{"trigger":"api"}`);
  toast('任务 API 已复制到剪贴板');
}

async function showTaskLog(taskId) {
  const run = latestRunForTask(taskId);
  if (!run) {
    toast('该任务暂无日志');
    return;
  }
  await openTaskLogModal(run.id, taskId);
}

async function openTaskLogModal(runId, taskId) {
  stopTaskLogRefresh();
  state.currentTaskLogRunId = runId;
  state.currentTaskLogTaskId = taskId || '';
  if (!els.taskLogModal.open) {
    els.taskLogModal.showModal();
  }
  const run = await renderTaskLogModal(runId);
  if (run?.status === 'running') startTaskLogRefresh(runId);
}

async function renderTaskLogModal(runId, options = {}) {
  try {
    const shouldAutoScroll = isTaskLogViewerNearBottom();
    const [run, log] = await Promise.all([
      api.getRun(runId),
      api.getRunLog(runId, 'combined')
    ]);
    upsertRunRecord(run);
    const task = state.tasks.find((item) => item.id === (run.taskId || state.currentTaskLogTaskId));
    const display = getRunDisplayInfo(run, task);
    const statusSuffix = run.status === 'running' ? ' · 实时刷新中' : '';
    els.taskLogTitle.textContent = `任务日志：${display.title}`;
    els.taskLogMeta.textContent = `${formatStatus(run.status)}${statusSuffix} · ${formatDateTime(run.startedAt)} · ${formatDuration(run.durationMs)} · ${formatTrigger(run.trigger)} · ${display.subtitle}`;
    const text = log.text || (run.status === 'running' ? '运行中，等待脚本输出...' : '日志为空');
    const changed = els.taskLogViewer.textContent !== text;
    if (changed) {
      els.taskLogViewer.textContent = text;
      if (shouldAutoScroll || run.status === 'running') {
        els.taskLogViewer.scrollTop = els.taskLogViewer.scrollHeight;
      }
    }
    renderRunsIfVisible();
    if (run.status !== 'running') {
      await refreshTasksAndRuns();
      renderMetrics();
      renderTasks();
      renderRunsIfVisible();
    }
    return run;
  } catch (error) {
    if (!options.silent) toast(formatError(error));
    return undefined;
  }
}

function startTaskLogRefresh(runId) {
  stopTaskLogRefresh();
  taskLogRefreshTimer = setInterval(async () => {
    if (state.currentTaskLogRunId !== runId || !els.taskLogModal.open) {
      stopTaskLogRefresh();
      return;
    }
    const run = await renderTaskLogModal(runId, { silent: true });
    if (!run || run.status !== 'running') {
      stopTaskLogRefresh();
    }
  }, 1000);
}

function stopTaskLogRefresh() {
  if (taskLogRefreshTimer) {
    clearInterval(taskLogRefreshTimer);
    taskLogRefreshTimer = undefined;
  }
  if (!els.taskLogModal?.open) {
    state.currentTaskLogRunId = '';
    state.currentTaskLogTaskId = '';
  }
}

async function copyTaskLog() {
  await api.copyText(els.taskLogViewer.textContent || '');
  toast('任务日志已复制到剪贴板');
}

async function openCurrentTaskLogPage() {
  const runId = state.currentTaskLogRunId;
  if (!runId) return;
  els.taskLogModal.close();
  await refreshTasksAndRuns();
  renderRuns();
  await showPage('log');
  await showRunLog(runId);
}

function isTaskLogViewerNearBottom() {
  if (!els.taskLogViewer) return true;
  return els.taskLogViewer.scrollHeight - els.taskLogViewer.scrollTop - els.taskLogViewer.clientHeight < 60;
}

async function openTaskDetail(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  state.detailTaskId = taskId;
  state.detailTab = 'log';
  await refreshTaskDetail(taskId);
  els.taskDetailModal.showModal();
}

async function refreshTaskDetail(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const latestRun = latestRunForTask(taskId);
  const status = getTaskStatus(task, latestRun);
  els.taskDetailTitle.textContent = task.name;
  els.taskDetailBody.innerHTML = renderTaskDetail(task, latestRun);
  els.detailEditTaskButton.onclick = () => {
    els.taskDetailModal.close();
    openTaskModal(task);
  };
  els.detailRunTaskButton.onclick = () => runTask(task.id);
  els.detailStopTaskButton.onclick = () => stopTask(task.id);
  els.detailToggleTaskButton.textContent = task.enabled ? '禁用' : '启用';
  els.detailToggleTaskButton.onclick = () => setTaskEnabled(task.id, !task.enabled);
  els.detailPinTaskButton.textContent = task.pinned ? '取消置顶' : '置顶';
  els.detailPinTaskButton.onclick = () => setTaskPinned(task.id, !task.pinned);
  els.detailRunTaskButton.hidden = status.value === 'running';
  els.detailStopTaskButton.hidden = status.value !== 'running';
  els.detailLogTab.onclick = () => showTaskDetailTab('log');
  els.detailScriptTab.onclick = () => showTaskDetailTab('script');
  await showTaskDetailTab(state.detailTab || 'log');
}

function renderTaskDetail(task, latestRun) {
  const status = getTaskStatus(task, latestRun);
  const pairs = [
    ['名称', task.name],
    ['命令/脚本', formatTaskScriptPath(task.scriptPath)],
    ['状态', status.label],
    ['定时规则', formatScheduleTitle(task)],
    ['下次运行', formatNextRun(task)],
    ['实例模式', task.allowMultipleInstances ? '多实例' : '单实例'],
    ['工作目录', task.cwd || 'data'],
    ['超时', task.timeoutMs ? formatDuration(task.timeoutMs) : '不限制'],
    ['标签', (task.labels || []).join(', ') || '-'],
    ['备注', task.remark || '-'],
    ['最后运行', latestRun ? `${formatStatus(latestRun.status)} / ${formatDateTime(latestRun.startedAt)}` : '-'],
    ['创建时间', formatDateTime(task.createdAt)],
    ['更新时间', formatDateTime(task.updatedAt)]
  ];
  return pairs.map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

async function showTaskDetailTab(tab) {
  state.detailTab = tab;
  els.detailLogTab.classList.toggle('active', tab === 'log');
  els.detailScriptTab.classList.toggle('active', tab === 'script');
  const task = state.tasks.find((item) => item.id === state.detailTaskId);
  if (!task) return;
  if (tab === 'script') {
    try {
      const script = await api.getScript(task.scriptPath);
      els.taskDetailContent.textContent = script.content || '脚本为空';
    } catch {
      els.taskDetailContent.textContent = `脚本路径: ${task.scriptPath}\n无法在脚本管理中直接读取，可能是绝对路径或文件已不存在。`;
    }
    return;
  }
  const latestRun = latestRunForTask(task.id);
  if (!latestRun) {
    els.taskDetailContent.textContent = '暂无运行日志';
    return;
  }
  const log = await api.getRunLog(latestRun.id, 'combined');
  els.taskDetailContent.textContent = log.text || '日志为空';
}

async function openTaskScript(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  await showPage('script');
  await loadScript(task.scriptPath);
}

async function handleLabelSubmit(event) {
  event.preventDefault();
  await updateSelectedLabels('add');
}

async function updateSelectedLabels(action) {
  const ids = [...state.selectedTaskIds];
  const labels = readLines('labelInput');
  if (!ids.length || !labels.length) return;
  await api.updateTaskLabels({ ids, labels, action });
  els.labelModal.close();
  await refreshTasksAndRuns();
  renderTasks();
  toast(action === 'remove' ? '标签已删除' : '标签已添加');
}

function openLabelModal() {
  els.labelInput.value = '';
  els.labelModal.showModal();
}

function showViewManager() {
  renderViewManageTable();
  els.viewManageModal.showModal();
}

function renderViewManageTable() {
  const views = [{ id: 'all', name: '全部任务', type: 'system', disabled: false }, ...getCrontabViews()];
  els.viewManageTable.innerHTML = `
    <table class="data-table compact-table">
      <thead>
        <tr>
          <th style="width: 180px">名称</th>
          <th style="width: 90px">类型</th>
          <th style="width: 90px">显示</th>
          <th>筛选</th>
          <th style="width: 240px">操作</th>
        </tr>
      </thead>
      <tbody>
        ${views.map((view) => `
          <tr>
            <td class="name-col">${escapeHtml(view.name)}</td>
            <td>${view.type === 'system' ? '系统' : '个人'}</td>
            <td>${view.disabled ? '<span class="tag red">隐藏</span>' : '<span class="tag green">显示</span>'}</td>
            <td class="mono">${escapeHtml(describeViewFilters(view))}</td>
            <td>
              ${view.type === 'system' ? '-' : `
                <button class="link-button" data-edit-view="${escapeAttr(view.id)}">编辑</button>
                <button class="link-button" data-toggle-view="${escapeAttr(view.id)}">${view.disabled ? '显示' : '隐藏'}</button>
                <button class="link-button red" data-delete-view="${escapeAttr(view.id)}">删除</button>
              `}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function handleViewManageClick(event) {
  const editButton = event.target.closest('[data-edit-view]');
  if (editButton) {
    const view = getCrontabViews().find((item) => item.id === editButton.dataset.editView);
    if (view) openViewModal(view);
    return;
  }

  const toggleButton = event.target.closest('[data-toggle-view]');
  if (toggleButton) {
    toggleView(toggleButton.dataset.toggleView);
    return;
  }

  const deleteButton = event.target.closest('[data-delete-view]');
  if (deleteButton) {
    deleteView(deleteButton.dataset.deleteView);
  }
}

function openViewModal(view) {
  els.viewForm.reset();
  const isEdit = Boolean(view?.id);
  els.viewModalTitle.textContent = isEdit ? '编辑视图' : '创建视图';
  els.viewIdInput.value = view?.id || '';
  els.viewNameInput.value = view?.name || '';
  els.viewRelationInput.value = view?.filterRelation || 'and';
  const firstFilter = view?.filters?.[0] || {};
  els.viewFilterPropertyInput.value = firstFilter.property || 'name';
  els.viewFilterOperationInput.value = firstFilter.operation || 'Reg';
  els.viewFilterValueInput.value = Array.isArray(firstFilter.value) ? firstFilter.value.join('\n') : firstFilter.value || '';
  els.viewManageModal.close();
  els.viewModal.showModal();
  els.viewNameInput.focus();
}

async function handleViewSubmit(event) {
  event.preventDefault();
  const viewId = els.viewIdInput.value || `view-${Date.now()}`;
  const views = getCrontabViews();
  const existing = views.find((view) => view.id === viewId);
  const nextView = {
    id: viewId,
    name: readValue('viewNameInput'),
    type: 'personal',
    disabled: existing?.disabled || false,
    filterRelation: els.viewRelationInput.value,
    filters: [{
      property: els.viewFilterPropertyInput.value,
      operation: els.viewFilterOperationInput.value,
      value: readLines('viewFilterValueInput')
    }],
    sorts: []
  };
  const nextViews = existing
    ? views.map((view) => (view.id === viewId ? nextView : view))
    : [...views, nextView];
  await saveCrontabSettings({
    activeViewId: viewId,
    views: nextViews
  });
  els.viewModal.close();
  state.taskPage = 1;
  renderTasks();
  toast(existing ? '视图已更新' : '视图已创建');
}

async function toggleView(viewId) {
  const views = getCrontabViews();
  const view = views.find((item) => item.id === viewId);
  if (!view) return;
  const visiblePersonalCount = views.filter((item) => !item.disabled).length;
  if (!view.disabled && visiblePersonalCount <= 1 && (state.settings?.crontab?.activeViewId || 'all') !== 'all') {
    await saveCrontabSettings({ activeViewId: 'all' });
  }
  await saveCrontabSettings({
    views: views.map((item) => (item.id === viewId ? { ...item, disabled: !item.disabled } : item))
  });
  renderViewManageTable();
  renderTasks();
}

async function deleteView(viewId) {
  const view = getCrontabViews().find((item) => item.id === viewId);
  if (!view) return;
  if (!await confirmAction({
    title: '删除视图',
    message: `确认删除视图「${view.name}」吗？`,
    okText: '删除',
    tone: 'danger'
  })) return;
  const activeViewId = state.settings?.crontab?.activeViewId === viewId ? 'all' : state.settings?.crontab?.activeViewId;
  await saveCrontabSettings({
    activeViewId,
    views: getCrontabViews().filter((item) => item.id !== viewId)
  });
  renderViewManageTable();
  renderTasks();
  toast('视图已删除');
}

function describeViewFilters(view) {
  if (view.id === 'all') return '全部任务';
  const filters = Array.isArray(view.filters) ? view.filters : [];
  if (!filters.length) return '无筛选条件';
  const relation = view.filterRelation === 'or' ? ' 或 ' : ' 且 ';
  return filters.map((filter) => {
    const names = {
      name: '名称',
      scriptPath: '命令/脚本',
      cronExpression: '定时规则',
      status: '状态',
      labels: '标签'
    };
    const operations = {
      Reg: '包含',
      NotReg: '不包含',
      In: '属于',
      Nin: '不属于'
    };
    const value = Array.isArray(filter.value) ? filter.value.join(', ') : filter.value;
    return `${names[filter.property] || filter.property} ${operations[filter.operation] || filter.operation} ${value}`;
  }).join(relation);
}

async function handleRunSubmit(event) {
  event.preventDefault();
  try {
    toast('脚本已开始启动');
    const result = await api.runScriptOnce({
      name: readValue('runNameInput') || '手动运行脚本',
      scriptPath: readValue('runScriptPathInput') || undefined,
      scriptContent: readValue('runScriptContentInput') || undefined,
      args: readLines('runArgsInput'),
      params: readJsonObject('runParamsInput', '结构化参数 JSON'),
      cwd: readValue('runCwdInput') || 'data',
      dependencies: readLines('runDependenciesInput'),
      autoInstallDependencies: els.runAutoInstallInput.checked,
      waitForCompletion: false,
      timeoutMs: readInteger('runTimeoutInput', 30000)
    });
    els.runModal.close();
    await refreshTasksAndRuns();
    renderMetrics();
    renderRuns();
    await showPage('log');
    await showRunLog(result.runId || result.data?.runId);
    toast('脚本已开始运行，日志正在实时刷新');
  } catch (error) {
    toast(formatError(error));
  }
}

function openRunModal() {
  els.runForm.reset();
  els.runNameInput.value = '手动运行脚本';
  els.runTimeoutInput.value = '30000';
  els.runCwdInput.value = 'data';
  els.runArgsInput.value = '参数A\n参数B';
  els.runParamsInput.value = JSON.stringify({ 来源: '界面' }, null, 2);
  els.runScriptContentInput.value = [
    'const params = JSON.parse(process.env.SCRIPTPILOT_PARAMS || "{}");',
    'console.log("直接运行成功");',
    'console.log(JSON.stringify({ args: process.argv.slice(2), params }));'
  ].join('\n');
  els.runAutoInstallInput.checked = true;
  els.runModal.showModal();
}

function renderEnvs() {
  const keyword = els.envSearchInput.value.trim().toLowerCase();
  const rows = state.envs.filter((item) => {
    if (!keyword) return true;
    return `${item.name} ${item.value} ${item.remarks}`.toLowerCase().includes(keyword);
  });
  state.selectedEnvIds = keepExistingSelection(state.selectedEnvIds, state.envs.map((item) => item.id));
  const allSelected = rows.length > 0 && rows.every((item) => state.selectedEnvIds.has(item.id));

  if (!rows.length) {
    setHtml(els.envTable, `<div class="empty">暂无环境变量，点击“新建变量”添加。</div>`);
    updateEnvButtons();
    return;
  }

  setHtml(els.envTable, `
    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col"><input id="selectAllEnvsInput" type="checkbox" ${allSelected ? 'checked' : ''}></th>
          <th style="width: 180px">名称</th>
          <th>值</th>
          <th style="width: 120px">状态</th>
          <th style="width: 180px">备注</th>
          <th style="width: 150px">更新时间</th>
          <th style="width: 150px">操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((item) => `
          <tr class="${state.selectedEnvIds.has(item.id) ? 'selected' : ''}" data-env-row="${escapeAttr(item.id)}">
            <td class="check-col"><input type="checkbox" data-env-check="${escapeAttr(item.id)}" ${state.selectedEnvIds.has(item.id) ? 'checked' : ''}></td>
            <td class="name-col">${escapeHtml(item.name)}</td>
            <td class="path-col" title="${escapeAttr(item.value)}">${escapeHtml(maskValue(item.value))}</td>
            <td><div class="tag-stack">${item.status === 'enabled' ? '<span class="tag green">启用</span>' : '<span class="tag red">禁用</span>'}${item.autoCreateTasks ? '<span class="tag blue">自动建任务</span>' : ''}</div></td>
            <td class="muted">${escapeHtml(item.remarks || '-')}</td>
            <td>${escapeHtml(formatDateTime(item.updatedAt))}</td>
            <td><div class="row-actions"><button class="link-button" data-edit-env="${escapeAttr(item.id)}">编辑</button><button class="link-button red" data-delete-env="${escapeAttr(item.id)}">删除</button></div></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `);
  updateEnvButtons();
}

function scheduleEnvRender() {
  if (envRenderFrame) cancelAnimationFrame(envRenderFrame);
  envRenderFrame = requestAnimationFrame(() => {
    envRenderFrame = undefined;
    renderEnvs();
  });
}

function getFilteredEnvs() {
  const keyword = els.envSearchInput.value.trim().toLowerCase();
  return state.envs.filter((item) => {
    if (!keyword) return true;
    return `${item.name} ${item.value} ${item.remarks}`.toLowerCase().includes(keyword);
  });
}

async function handleEnvTableClick(event) {
  const editButton = event.target.closest('[data-edit-env]');
  if (editButton) {
    event.stopPropagation();
    openEnvModal(state.envs.find((item) => item.id === editButton.dataset.editEnv));
    return;
  }

  const deleteButton = event.target.closest('[data-delete-env]');
  if (deleteButton) {
    event.stopPropagation();
    if (!await confirmAction({
      title: '删除环境变量',
      message: '确定删除该环境变量吗？',
      okText: '删除',
      tone: 'danger'
    })) return;
    await deleteEnv(deleteButton.dataset.deleteEnv);
    return;
  }

  const row = event.target.closest('[data-env-row]');
  if (row && !event.target.closest('button,input')) {
    toggleSet(state.selectedEnvIds, row.dataset.envRow, !state.selectedEnvIds.has(row.dataset.envRow));
    renderEnvs();
  }
}

function handleEnvTableChange(event) {
  if (event.target.id === 'selectAllEnvsInput') {
    getFilteredEnvs().forEach((item) => toggleSet(state.selectedEnvIds, item.id, event.target.checked));
    renderEnvs();
    return;
  }

  const checkbox = event.target.closest('[data-env-check]');
  if (checkbox) {
    toggleSet(state.selectedEnvIds, checkbox.dataset.envCheck, checkbox.checked);
    renderEnvs();
  }
}

async function refreshEnvs() {
  const envs = await api.listEnvs();
  state.envs = envs.items || [];
  state.selectedEnvIds = keepExistingSelection(state.selectedEnvIds, state.envs.map((item) => item.id));
  renderMetrics();
  renderEnvs();
}

function updateEnvButtons() {
  const count = state.selectedEnvIds.size;
  els.envSelectionText.textContent = `已选择 ${count} 项`;
  [els.batchEnableEnvsButton, els.batchDisableEnvsButton, els.batchDeleteEnvsButton].forEach((button) => {
    button.disabled = count === 0;
  });
}

function openEnvModal(env) {
  els.envForm.reset();
  els.envModalTitle.textContent = env ? '编辑变量' : '新建变量';
  els.envIdInput.value = env?.id || '';
  els.envNameInput.value = env?.name || '';
  els.envValueInput.value = env?.value || '';
  els.envRemarksInput.value = env?.remarks || '';
  els.envStatusInput.value = env?.status || 'enabled';
  els.envModal.showModal();
  els.envNameInput.focus();
}

async function handleEnvSubmit(event) {
  event.preventDefault();
  try {
    await api.saveEnv({
      id: els.envIdInput.value || undefined,
      name: readValue('envNameInput'),
      value: els.envValueInput.value,
      remarks: readValue('envRemarksInput'),
      status: els.envStatusInput.value
    });
    els.envModal.close();
    await refreshEnvs();
    toast('变量已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

async function batchSetEnvsStatus(status) {
  const ids = [...state.selectedEnvIds];
  if (!ids.length) return;
  const snapshots = state.envs.map((item) => ({ ...item }));
  const now = new Date().toISOString();
  const idSet = new Set(ids);
  state.envs = state.envs.map((item) => idSet.has(item.id) ? { ...item, status, updatedAt: now } : item);
  renderMetrics();
  renderEnvs();
  try {
    await api.setEnvStatus(ids, status);
    await refreshEnvs();
    toast(status === 'enabled' ? `已启用 ${ids.length} 个变量` : `已禁用 ${ids.length} 个变量`);
  } catch (error) {
    state.envs = snapshots;
    renderMetrics();
    renderEnvs();
    toast(formatError(error));
  }
}

async function deleteEnv(id) {
  const snapshots = state.envs.map((item) => ({ ...item }));
  state.envs = state.envs.filter((item) => item.id !== id);
  state.selectedEnvIds.delete(id);
  renderMetrics();
  renderEnvs();
  try {
    await api.deleteEnvs([id]);
    await refreshEnvs();
    toast('变量已删除');
  } catch (error) {
    state.envs = snapshots;
    renderMetrics();
    renderEnvs();
    toast(formatError(error));
  }
}

async function batchDeleteEnvs() {
  const ids = [...state.selectedEnvIds];
  if (!ids.length) return;
  if (!await confirmAction({
    title: '批量删除变量',
    message: `确定删除选中的 ${ids.length} 个变量吗？`,
    okText: '批量删除',
    tone: 'danger'
  })) return;
  const snapshots = state.envs.map((item) => ({ ...item }));
  const idSet = new Set(ids);
  state.envs = state.envs.filter((item) => !idSet.has(item.id));
  state.selectedEnvIds.clear();
  renderMetrics();
  renderEnvs();
  try {
    await api.deleteEnvs(ids);
    await refreshEnvs();
    toast(`已删除 ${ids.length} 个变量`);
  } catch (error) {
    state.envs = snapshots;
    renderMetrics();
    renderEnvs();
    toast(formatError(error));
  }
}

function renderSubscriptions() {
  state.selectedSubscriptionIds = keepExistingSelection(state.selectedSubscriptionIds, state.subscriptions.map((item) => item.id));
  const rows = state.subscriptions;
  const allSelected = rows.length > 0 && rows.every((item) => state.selectedSubscriptionIds.has(item.id));
  if (!rows.length) {
    setHtml(els.subscriptionTable, `<div class="empty">暂无订阅，点击“新建订阅”添加。</div>`);
    updateSubscriptionButtons();
    return;
  }

  setHtml(els.subscriptionTable, `
    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col"><input id="selectAllSubscriptionsInput" type="checkbox" ${allSelected ? 'checked' : ''}></th>
          <th style="width: 180px">名称</th>
          <th>地址</th>
          <th style="width: 120px">分支</th>
          <th style="width: 190px">本地目录</th>
          <th style="width: 120px">状态</th>
          <th style="width: 150px">最后运行</th>
          <th style="width: 220px">运行结果</th>
          <th style="width: 160px">操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((item) => `
          <tr class="${state.selectedSubscriptionIds.has(item.id) ? 'selected' : ''}" data-subscription-row="${escapeAttr(item.id)}">
            <td class="check-col"><input type="checkbox" data-subscription-check="${escapeAttr(item.id)}" ${state.selectedSubscriptionIds.has(item.id) ? 'checked' : ''}></td>
            <td class="name-col">${escapeHtml(item.name)}</td>
            <td class="path-col" title="${escapeAttr(item.url)}">${escapeHtml(item.url || '-')}</td>
            <td>${escapeHtml(item.branch || '-')}</td>
            <td class="path-col" title="${escapeAttr(item.localPath || '-')}">${escapeHtml(item.localPath || '-')}</td>
            <td>${item.status === 'enabled' ? '<span class="tag green">启用</span>' : '<span class="tag red">禁用</span>'}</td>
            <td>${item.lastPulledAt ? escapeHtml(formatDateTime(item.lastPulledAt)) : '-'}</td>
            <td class="path-col" title="${escapeAttr(item.lastResult || '-')}">${escapeHtml(item.lastResult || '-')}</td>
            <td><div class="row-actions"><button class="link-button" data-run-subscription="${escapeAttr(item.id)}" ${state.runningSubscriptionIds.has(item.id) ? 'disabled' : ''}>${state.runningSubscriptionIds.has(item.id) ? '运行中...' : '运行'}</button><button class="link-button" data-log-subscription="${escapeAttr(item.id)}">日志</button><button class="link-button" data-edit-subscription="${escapeAttr(item.id)}">编辑</button><button class="link-button red" data-delete-subscription="${escapeAttr(item.id)}">删除</button></div></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `);
  updateSubscriptionButtons();
}

async function handleSubscriptionTableClick(event) {
  const runButton = event.target.closest('[data-run-subscription]');
  if (runButton) {
    event.stopPropagation();
    await runSubscription(runButton.dataset.runSubscription);
    return;
  }

  const logButton = event.target.closest('[data-log-subscription]');
  if (logButton) {
    event.stopPropagation();
    await showSubscriptionLog(logButton.dataset.logSubscription);
    return;
  }

  const editButton = event.target.closest('[data-edit-subscription]');
  if (editButton) {
    event.stopPropagation();
    openSubscriptionModal(state.subscriptions.find((item) => item.id === editButton.dataset.editSubscription));
    return;
  }

  const deleteButton = event.target.closest('[data-delete-subscription]');
  if (deleteButton) {
    event.stopPropagation();
    if (!await confirmAction({
      title: '删除订阅',
      message: '确定删除该订阅吗？对应下载的订阅脚本目录也会删除。',
      okText: '删除',
      tone: 'danger'
    })) return;
    await deleteSubscription(deleteButton.dataset.deleteSubscription);
    return;
  }

  const row = event.target.closest('[data-subscription-row]');
  if (row && !event.target.closest('button,input')) {
    toggleSet(state.selectedSubscriptionIds, row.dataset.subscriptionRow, !state.selectedSubscriptionIds.has(row.dataset.subscriptionRow));
    renderSubscriptions();
  }
}

function handleSubscriptionTableChange(event) {
  if (event.target.id === 'selectAllSubscriptionsInput') {
    state.subscriptions.forEach((item) => toggleSet(state.selectedSubscriptionIds, item.id, event.target.checked));
    renderSubscriptions();
    return;
  }

  const checkbox = event.target.closest('[data-subscription-check]');
  if (checkbox) {
    toggleSet(state.selectedSubscriptionIds, checkbox.dataset.subscriptionCheck, checkbox.checked);
    renderSubscriptions();
  }
}

function updateSubscriptionButtons() {
  const count = state.selectedSubscriptionIds.size;
  els.subscriptionSelectionText.textContent = `已选择 ${count} 项`;
  [els.batchRunSubscriptionsButton, els.batchDeleteSubscriptionsButton].forEach((button) => {
    button.disabled = count === 0;
  });
}

async function refreshSubscriptions() {
  const subscriptions = await api.listSubscriptions();
  state.subscriptions = subscriptions.items || [];
  renderSubscriptions();
}

async function refreshQinglongOverview() {
  state.overview = await api.qlOverview();
  renderMetrics();
}

function openSubscriptionModal(subscription) {
  els.subscriptionForm.reset();
  els.subscriptionModalTitle.textContent = subscription ? '编辑订阅' : '新建订阅';
  els.subscriptionIdInput.value = subscription?.id || '';
  els.subscriptionNameInput.value = subscription?.name || '';
  els.subscriptionUrlInput.value = subscription?.url || '';
  els.subscriptionBranchInput.value = subscription?.branch || '';
  els.subscriptionScheduleInput.value = subscription?.schedule || '';
  els.subscriptionStatusInput.value = subscription?.status || 'enabled';
  els.subscriptionAutoCreateTasksInput.checked = Boolean(subscription?.autoCreateTasks);
  els.subscriptionModal.showModal();
}

async function handleSubscriptionSubmit(event) {
  event.preventDefault();
  try {
    const saved = await api.saveSubscription({
      id: els.subscriptionIdInput.value || undefined,
      name: readValue('subscriptionNameInput'),
      url: readValue('subscriptionUrlInput'),
      branch: readValue('subscriptionBranchInput'),
      schedule: readValue('subscriptionScheduleInput'),
      status: els.subscriptionStatusInput.value,
      autoCreateTasks: els.subscriptionAutoCreateTasksInput.checked
    });
    upsertSubscription(saved);
    els.subscriptionModal.close();
    await refreshQinglongOverview();
    toast('订阅已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

async function deleteSubscription(id) {
  const snapshots = state.subscriptions.map((item) => ({ ...item }));
  state.subscriptions = state.subscriptions.filter((item) => item.id !== id);
  state.selectedSubscriptionIds.delete(id);
  renderSubscriptions();
  try {
    await api.deleteSubscriptions([id]);
    await Promise.all([
      refreshSubscriptions(),
      refreshScripts()
    ]);
    renderMetrics();
    toast('订阅已删除');
  } catch (error) {
    state.subscriptions = snapshots;
    renderSubscriptions();
    toast(formatError(error));
  }
}

async function runSubscription(id) {
  const name = getSubscriptionName(id);
  setSubscriptionRunStatus(`正在启动订阅：${name}`, 'info');
  state.runningSubscriptionIds.add(id);
  renderSubscriptions();
  toast(`正在启动订阅：${name}`, { tone: 'info', persist: true });
  try {
    const result = await api.runSubscription(id, { background: true });
    upsertSubscription(result);
    const runId = result?.runId || result?.lastRunId;
    await Promise.all([
      refreshSubscriptions(),
      refreshTasksAndRuns()
    ]);
    renderRuns();
    if (runId) {
      await openSubscriptionLogModal(runId, id);
      const message = `订阅已开始运行：${name}，日志弹窗正在实时刷新`;
      setSubscriptionRunStatus(message, 'info');
      toast(message, { tone: 'info', durationMs: 6000 });
      watchSubscriptionRun(runId, id, name).catch((error) => {
        setSubscriptionRunStatus(`订阅状态刷新失败：${formatError(error)}`, 'error');
        toast(formatError(error), { tone: 'error', durationMs: 8000 });
      });
      return;
    }

    await Promise.all([
      refreshScripts(),
      refreshQinglongOverview()
    ]);
    const message = formatSubscriptionRunSuccess(result, name);
    setSubscriptionRunStatus(message, 'success');
    toast(message, { tone: 'success', durationMs: 7000 });
    state.runningSubscriptionIds.delete(id);
  } catch (error) {
    const message = `订阅运行失败：${formatError(error)}`;
    setSubscriptionRunStatus(message, 'error');
    toast(message, { tone: 'error', durationMs: 8000 });
    state.runningSubscriptionIds.delete(id);
  }
  renderSubscriptions();
}

async function batchRunSubscriptions() {
  const ids = [...state.selectedSubscriptionIds];
  if (!ids.length) return;
  setSubscriptionRunStatus(`正在启动 ${ids.length} 个订阅...`, 'info');
  ids.forEach((id) => state.runningSubscriptionIds.add(id));
  renderSubscriptions();
  toast(`正在启动 ${ids.length} 个订阅...`, { tone: 'info', persist: true });
  const results = [];
  try {
    for (const id of ids) {
      const result = await api.runSubscription(id, { background: true });
      results.push(result);
      upsertSubscription(result);
    }
    await Promise.all([
      refreshSubscriptions(),
      refreshTasksAndRuns()
    ]);
    renderRuns();
    const names = results
      .map((item) => item?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join('、');
    const message = `已启动 ${results.length} 个订阅：${names || '等待运行完成'}，点击对应“日志”查看实时输出`;
    setSubscriptionRunStatus(message, 'info');
    toast(message, { tone: 'info', durationMs: 8000 });
    results.forEach((result) => {
      const runId = result?.runId || result?.lastRunId;
      if (!runId || !result?.id) {
        if (result?.id) state.runningSubscriptionIds.delete(result.id);
        return;
      }
      if (!state.currentSubscriptionLogRunId) {
        openSubscriptionLogModal(runId, result.id).catch((error) => {
          toast(formatError(error), { tone: 'error', durationMs: 8000 });
        });
      }
      watchSubscriptionRun(runId, result.id, result.name).catch((error) => {
        setSubscriptionRunStatus(`订阅状态刷新失败：${formatError(error)}`, 'error');
        toast(formatError(error), { tone: 'error', durationMs: 8000 });
      });
    });
    renderSubscriptions();
  } catch (error) {
    await Promise.all([
      refreshSubscriptions(),
      refreshScripts(),
      refreshQinglongOverview()
    ]);
    const message = `订阅运行失败：${formatError(error)}`;
    setSubscriptionRunStatus(message, 'error');
    toast(message, { tone: 'error', durationMs: 8000 });
    ids.forEach((id) => state.runningSubscriptionIds.delete(id));
    renderSubscriptions();
  }
}

async function showSubscriptionLog(id) {
  const subscription = state.subscriptions.find((item) => item.id === id);
  const runId = subscription?.lastRunId;
  if (!runId) {
    toast('该订阅暂无弹窗日志，请重新运行一次订阅生成日志');
    return;
  }
  await openSubscriptionLogModal(runId, id);
}

async function openSubscriptionLogModal(runId, subscriptionId) {
  stopSubscriptionLogRefresh();
  state.currentSubscriptionLogRunId = runId;
  state.currentSubscriptionLogSubscriptionId = subscriptionId || '';
  if (!els.subscriptionLogModal.open) {
    els.subscriptionLogModal.showModal();
  }
  const run = await renderSubscriptionLog(runId);
  if (run?.status === 'running') startSubscriptionLogRefresh(runId);
}

async function renderSubscriptionLog(runId, options = {}) {
  try {
    const shouldAutoScroll = isSubscriptionLogViewerNearBottom();
    const [run, log] = await Promise.all([
      api.getRun(runId),
      api.getRunLog(runId, 'combined')
    ]);
    upsertRunRecord(run);
    const subscription = state.subscriptions.find((item) => item.lastRunId === runId || item.id === state.currentSubscriptionLogSubscriptionId);
    const statusSuffix = run.status === 'running' ? ' · 实时刷新中' : '';
    els.subscriptionLogTitle.textContent = subscription?.name ? `订阅日志：${subscription.name}` : (run.name || '订阅日志');
    els.subscriptionLogMeta.textContent = `${formatStatus(run.status)}${statusSuffix} · ${formatDateTime(run.startedAt)} · ${formatDuration(run.durationMs)} · ${run.scriptPath || '-'}`;
    const text = log.text || (run.status === 'running' ? '运行中，等待订阅输出...' : '日志为空');
    const changed = els.subscriptionLogViewer.textContent !== text;
    if (changed) {
      els.subscriptionLogViewer.textContent = text;
      if (shouldAutoScroll || run.status === 'running') {
        els.subscriptionLogViewer.scrollTop = els.subscriptionLogViewer.scrollHeight;
      }
    }
    renderRunsIfVisible();
    if (run.status !== 'running') {
      await refreshAfterSubscriptionRun(runId);
    }
    return run;
  } catch (error) {
    if (!options.silent) toast(formatError(error), { tone: 'error', durationMs: 8000 });
    return undefined;
  }
}

function startSubscriptionLogRefresh(runId) {
  stopSubscriptionLogRefresh();
  subscriptionLogRefreshTimer = setInterval(async () => {
    if (state.currentSubscriptionLogRunId !== runId || !els.subscriptionLogModal.open) {
      stopSubscriptionLogRefresh();
      return;
    }
    const run = await renderSubscriptionLog(runId, { silent: true });
    if (!run || run.status !== 'running') {
      stopSubscriptionLogRefresh();
    }
  }, 1000);
}

function stopSubscriptionLogRefresh() {
  if (subscriptionLogRefreshTimer) {
    clearInterval(subscriptionLogRefreshTimer);
    subscriptionLogRefreshTimer = undefined;
  }
  if (!els.subscriptionLogModal?.open) {
    state.currentSubscriptionLogRunId = '';
    state.currentSubscriptionLogSubscriptionId = '';
  }
}

async function copySubscriptionLog() {
  await api.copyText(els.subscriptionLogViewer.textContent || '');
  toast('订阅日志已复制到剪贴板');
}

async function openCurrentSubscriptionLogPage() {
  const runId = state.currentSubscriptionLogRunId;
  if (!runId) return;
  els.subscriptionLogModal.close();
  await refreshTasksAndRuns();
  renderRuns();
  await showPage('log');
  await showRunLog(runId);
}

function isSubscriptionLogViewerNearBottom() {
  if (!els.subscriptionLogViewer) return true;
  return els.subscriptionLogViewer.scrollHeight - els.subscriptionLogViewer.scrollTop - els.subscriptionLogViewer.clientHeight < 60;
}

async function watchSubscriptionRun(runId, subscriptionId, fallbackName) {
  let run;
  try {
    do {
      await delay(1000);
      run = await api.getRun(runId);
      upsertRunRecord(run);
      renderRunsIfVisible();
      if (state.currentSubscriptionLogRunId === runId && els.subscriptionLogModal.open) {
        await renderSubscriptionLog(runId, { silent: true });
      }
      if (state.currentRunId === runId) {
        await renderRunLog(runId, { silent: true });
      }
    } while (run?.status === 'running');

    await refreshAfterSubscriptionRun(runId);

    const subscription = state.subscriptions.find((item) => item.id === subscriptionId);
    if (run?.status === 'success') {
      const message = formatSubscriptionRunSuccess(subscription, fallbackName);
      setSubscriptionRunStatus(message, 'success');
      toast(message, { tone: 'success', durationMs: 7000 });
      return;
    }

    const message = `订阅运行失败：${subscription?.lastError || run?.errorMessage || formatStatus(run?.status)}`;
    setSubscriptionRunStatus(message, 'error');
    toast(message, { tone: 'error', durationMs: 8000 });
  } finally {
    state.runningSubscriptionIds.delete(subscriptionId);
    renderSubscriptions();
  }
}

async function batchDeleteSubscriptions() {
  const ids = [...state.selectedSubscriptionIds];
  if (!ids.length) return;
  if (!await confirmAction({
    title: '批量删除订阅',
    message: `确定删除选中的 ${ids.length} 个订阅吗？对应下载的订阅脚本目录也会删除。`,
    okText: '批量删除',
    tone: 'danger'
  })) return;
  await api.deleteSubscriptions(ids);
  state.selectedSubscriptionIds.clear();
  await Promise.all([
    refreshSubscriptions(),
    refreshScripts(),
    refreshQinglongOverview()
  ]);
  toast(`已删除 ${ids.length} 个订阅`);
}

function renderConfigs() {
  if (!state.configs.length) {
    setHtml(els.configList, '<div class="empty">暂无配置文件</div>');
    return;
  }
  setHtml(els.configList, state.configs.map((item) => `
    <button class="file-item ${state.currentConfigName === item.name ? 'active' : ''}" data-config-name="${escapeAttr(item.name)}">
      <strong>${escapeHtml(item.name)}</strong>
      <small>${escapeHtml(formatBytes(item.size))} · ${escapeHtml(formatDateTime(item.updatedAt))}</small>
    </button>
  `).join(''));
}

function handleConfigListClick(event) {
  const button = event.target.closest('[data-config-name]');
  if (button) loadConfig(button.dataset.configName);
}

async function refreshConfigs() {
  const result = await api.listConfigs();
  state.configs = result.items || [];
  renderConfigs();
}

async function loadConfig(name) {
  try {
    const config = await api.getConfig(name);
    state.currentConfigName = config.name;
    els.configEditorTitle.textContent = config.name;
    els.configEditorPath.textContent = `data/configs/${config.name}`;
    els.configEditor.value = config.content;
    renderConfigs();
  } catch (error) {
    toast(formatError(error));
  }
}

async function saveCurrentConfig() {
  if (!state.currentConfigName) {
    toast('请先选择配置文件');
    return;
  }
  try {
    await api.saveConfig({ name: state.currentConfigName, content: els.configEditor.value });
    await refreshConfigs();
    toast('配置已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

async function openCurrentConfigDirectory() {
  await openPortableDirectory('data/configs');
}

async function refreshScripts() {
  const scripts = await api.listScripts();
  state.scripts = scripts.items || [];
  state.scriptTree = undefined;
  state.selectedScriptPaths = keepExistingSelection(state.selectedScriptPaths, state.scripts.map((item) => item.path));
  renderMetrics();
  renderScripts();
}

function renderScripts() {
  updateScriptButtons();
  if (!state.scripts.length) {
    setHtml(els.scriptList, '<div class="empty">暂无脚本文件</div>');
    if (els.selectAllScriptsInput) {
      els.selectAllScriptsInput.checked = false;
      els.selectAllScriptsInput.indeterminate = false;
    }
    return;
  }
  const allSelected = state.scripts.length > 0 && state.scripts.every((item) => state.selectedScriptPaths.has(item.path));
  const tree = getScriptTree();
  expandScriptParents(state.currentScriptPath);
  syncVisibleScriptDirectories(tree);
  setHtml(els.scriptList, `<div class="script-tree">${renderScriptTreeChildren(tree, 0)}</div>`);
  els.selectAllScriptsInput.checked = allSelected;
  els.scriptList.querySelectorAll('[data-script-dir-check]').forEach((checkbox) => {
    checkbox.indeterminate = checkbox.dataset.indeterminate === 'true';
  });
}

function getScriptTree() {
  if (!state.scriptTree) state.scriptTree = buildScriptTree(state.scripts);
  return state.scriptTree;
}

function handleScriptListClick(event) {
  const toggle = event.target.closest('[data-script-dir-toggle]');
  if (toggle) {
    event.stopPropagation();
    toggleScriptDirectory(toggle.dataset.scriptDirToggle);
    return;
  }

  const dirRow = event.target.closest('[data-script-dir-row]');
  if (dirRow && !event.target.closest('input,button')) {
    toggleScriptDirectory(dirRow.dataset.scriptDirRow);
    return;
  }

  const scriptRow = event.target.closest('[data-script-path]');
  if (scriptRow && !event.target.closest('input')) {
    loadScript(scriptRow.dataset.scriptPath);
  }
}

function handleScriptListChange(event) {
  const dirCheckbox = event.target.closest('[data-script-dir-check]');
  if (dirCheckbox) {
    toggleScriptDirectorySelection(dirCheckbox.dataset.scriptDirCheck, dirCheckbox.checked);
    renderScripts();
    return;
  }

  const scriptCheckbox = event.target.closest('[data-script-check]');
  if (scriptCheckbox) {
    toggleSet(state.selectedScriptPaths, scriptCheckbox.dataset.scriptCheck, scriptCheckbox.checked);
    renderScripts();
  }
}

function buildScriptTree(scripts) {
  const root = createScriptTreeNode('data/scripts', 'data/scripts');
  const sorted = [...scripts].toSorted((a, b) => a.path.localeCompare(b.path));
  for (const item of sorted) {
    const relativePath = item.path.replace(/^data\/scripts\/?/, '');
    if (!relativePath) continue;
    const parts = relativePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    let current = root;
    let currentPath = 'data/scripts';
    current.scriptPaths.push(item.path);
    for (const dirName of parts) {
      currentPath = `${currentPath}/${dirName}`;
      if (!current.dirs.has(dirName)) {
        current.dirs.set(dirName, createScriptTreeNode(dirName, currentPath));
      }
      current = current.dirs.get(dirName);
      current.scriptPaths.push(item.path);
    }
    current.files.push({ ...item, name: fileName || item.name });
  }
  return root;
}

function createScriptTreeNode(name, nodePath) {
  return {
    name,
    path: nodePath,
    dirs: new Map(),
    files: [],
    scriptPaths: []
  };
}

function renderScriptTreeChildren(node, depth) {
  const dirs = [...node.dirs.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].toSorted((a, b) => a.name.localeCompare(b.name));
  return [
    ...dirs.map((dir) => renderScriptDirectory(dir, depth)),
    ...files.map((file) => renderScriptFile(file, depth))
  ].join('');
}

function syncVisibleScriptDirectories(tree, expandedDirs = state.expandedScriptDirs) {
  const dirs = collectScriptDirPaths(tree);
  const nextDirSet = new Set(['data/scripts', ...dirs]);
  for (const dirPath of [...expandedDirs]) {
    if (!nextDirSet.has(dirPath)) expandedDirs.delete(dirPath);
  }
}

function collectScriptDirPaths(node) {
  return [...node.dirs.values()].flatMap((dir) => [
    dir.path,
    ...collectScriptDirPaths(dir)
  ]);
}

function renderScriptDirectory(node, depth) {
  const expanded = state.expandedScriptDirs.has(node.path);
  const paths = collectScriptPaths(node);
  const selectedCount = paths.filter((scriptPath) => state.selectedScriptPaths.has(scriptPath)).length;
  const checked = paths.length > 0 && selectedCount === paths.length;
  const indeterminate = selectedCount > 0 && !checked;
  return `
    <div class="script-tree-node">
      <div class="script-tree-row script-tree-dir" style="--depth:${depth}" data-script-dir-row="${escapeAttr(node.path)}">
      <button class="script-tree-toggle" type="button" data-script-dir-toggle="${escapeAttr(node.path)}">${expanded ? '▾' : '▸'}</button>
      <input type="checkbox" data-script-dir-check="${escapeAttr(node.path)}" data-indeterminate="${indeterminate}" ${checked ? 'checked' : ''}>
      <span class="script-tree-name">
        <strong>${escapeHtml(node.name)}</strong>
        <small>${paths.length} 个脚本</small>
      </span>
      </div>
      ${expanded ? `<div class="script-tree-children">${renderScriptTreeChildren(node, depth + 1)}</div>` : ''}
    </div>
  `;
}

function renderScriptFile(item, depth) {
  return `
    <div class="file-item script-file-item ${state.currentScriptPath === item.path ? 'active' : ''} ${state.selectedScriptPaths.has(item.path) ? 'selected' : ''}" style="--depth:${depth}" data-script-path="${escapeAttr(item.path)}">
      <input type="checkbox" data-script-check="${escapeAttr(item.path)}" ${state.selectedScriptPaths.has(item.path) ? 'checked' : ''}>
      <span class="script-file-meta">
        <strong title="${escapeAttr(item.path)}">${escapeHtml(item.name)}</strong>
      </span>
      <span class="script-file-size">${escapeHtml(formatBytes(item.size))}</span>
    </div>
  `;
}

function collectVisibleScriptPaths(node) {
  return [
    ...node.files.map((item) => item.path),
    ...[...node.dirs.values()].flatMap((child) => collectVisibleScriptPaths(child))
  ];
}

function collectVisibleRootScriptPaths() {
  return state.scripts.map((item) => item.path);
}

function updateSelectAllScriptsState() {
  if (!els.selectAllScriptsInput) return;
  const visiblePaths = collectVisibleRootScriptPaths();
  const selectedVisibleCount = visiblePaths.filter((item) => state.selectedScriptPaths.has(item)).length;
  els.selectAllScriptsInput.checked = visiblePaths.length > 0 && selectedVisibleCount === visiblePaths.length;
  els.selectAllScriptsInput.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visiblePaths.length;
}

function collectScriptPaths(node) {
  return node?.scriptPaths || [];
}

function findScriptTreeNode(node, dirPath) {
  if (!node) return undefined;
  if (node.path === dirPath) return node;
  for (const child of node.dirs.values()) {
    const match = findScriptTreeNode(child, dirPath);
    if (match) return match;
  }
  return undefined;
}

function toggleScriptDirectory(dirPath) {
  if (state.expandedScriptDirs.has(dirPath)) state.expandedScriptDirs.delete(dirPath);
  else state.expandedScriptDirs.add(dirPath);
  renderScripts();
}

function toggleScriptDirectorySelection(dirPath, checked) {
  const paths = state.scripts
    .map((item) => item.path)
    .filter((scriptPath) => scriptPath.startsWith(`${dirPath}/`));
  for (const scriptPath of paths) {
    toggleSet(state.selectedScriptPaths, scriptPath, checked);
  }
}

function expandScriptParents(scriptPath, expandedDirs = state.expandedScriptDirs) {
  const normalized = String(scriptPath || '').replaceAll('\\', '/');
  if (!normalized.startsWith('data/scripts/')) return;
  const parts = normalized.split('/').slice(0, -1);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (current.startsWith('data/scripts')) expandedDirs.add(current);
  }
}

function updateScriptButtons() {
  const count = state.selectedScriptPaths.size;
  els.scriptBatchBar.hidden = state.scripts.length === 0;
  els.scriptSelectionText.textContent = `${count} 项`;
  els.batchRunScriptsButton.disabled = count === 0;
  els.batchDeleteScriptsButton.disabled = count === 0;
  els.clearScriptSelectionButton.disabled = count === 0;
  updateSelectAllScriptsState();
}

function toggleAllScripts(checked) {
  state.selectedScriptPaths = checked
    ? new Set(state.scripts.map((item) => item.path))
    : new Set();
  renderScripts();
}

function clearScriptSelection() {
  state.selectedScriptPaths.clear();
  renderScripts();
}

function newScript() {
  const fileName = `data/scripts/new-script-${Date.now()}.js`;
  state.currentScriptPath = fileName;
  els.scriptPathInput.value = fileName;
  els.scriptEditor.value = 'console.log("hello ScriptPilot");\n';
  expandScriptParents(fileName);
  renderScripts();
}

async function loadScript(scriptPath) {
  try {
    const script = await api.getScript(scriptPath);
    state.currentScriptPath = script.path;
    els.scriptPathInput.value = script.path;
    els.scriptEditor.value = script.content;
    expandScriptParents(script.path);
    renderScripts();
  } catch (error) {
    toast(formatError(error));
  }
}

async function saveCurrentScript() {
  const scriptPath = readValue('scriptPathInput');
  if (!scriptPath) {
    toast('请输入脚本路径');
    return;
  }
  try {
    const result = await api.saveScript({ path: scriptPath, content: els.scriptEditor.value });
    state.currentScriptPath = result.path;
    els.scriptPathInput.value = result.path;
    const scripts = await api.listScripts();
    state.scripts = scripts.items || [];
    state.scriptTree = undefined;
    renderMetrics();
    renderScripts();
    toast('脚本已保存');
  } catch (error) {
    toast(formatError(error));
  }
}

async function openCurrentScriptDirectory() {
  const scriptPath = readValue('scriptPathInput') || state.currentScriptPath || 'data/scripts';
  const kind = scriptPath === 'data/scripts' ? 'directory' : 'file';
  await openPortableDirectory(scriptPath, kind);
}

async function openPortableDirectory(portablePath, kind = 'directory') {
  try {
    const openPath = typeof window.__scriptPilotOpenPortablePath === 'function'
      ? window.__scriptPilotOpenPortablePath
      : api.openPortablePath;
    const result = await openPath({ path: portablePath, kind });
    toast(`已打开目录: ${result.path}`);
  } catch (error) {
    toast(formatError(error));
  }
}

async function runCurrentScript() {
  const scriptPath = readValue('scriptPathInput');
  if (!scriptPath) {
    toast('请输入脚本路径');
    return;
  }
  if (state.launchingScriptPaths.has(scriptPath)) {
    toast('该脚本正在启动，请在日志页查看实时输出');
    return;
  }
  try {
    state.launchingScriptPaths.add(scriptPath);
    els.runScriptFileButton.disabled = true;
    els.runScriptFileButton.textContent = '启动中';
    await saveCurrentScript();
    const result = await api.runScriptOnce({
      name: scriptPath.split('/').pop() || '脚本文件运行',
      scriptPath,
      cwd: 'data',
      waitForCompletion: false,
      timeoutMs: 30000
    });
    await refreshTasksAndRuns();
    renderRuns();
    await showPage('log');
    await showRunLog(result.runId || result.data?.runId);
    toast('脚本已开始运行，日志正在实时刷新');
  } catch (error) {
    toast(formatError(error));
  } finally {
    state.launchingScriptPaths.delete(scriptPath);
    els.runScriptFileButton.disabled = false;
    els.runScriptFileButton.textContent = '运行';
  }
}

async function deleteCurrentScript() {
  const scriptPath = readValue('scriptPathInput') || state.currentScriptPath;
  if (!scriptPath) return;
  if (!await confirmAction({
    title: '删除脚本',
    message: '确定删除当前脚本吗？删除后会从 data/scripts 中移除文件。',
    details: scriptPath,
    okText: '删除',
    tone: 'danger'
  })) return;
  try {
    await api.deleteScripts([scriptPath]);
    state.selectedScriptPaths.delete(scriptPath);
    state.currentScriptPath = '';
    els.scriptPathInput.value = '';
    els.scriptEditor.value = '';
    const scripts = await api.listScripts();
    state.scripts = scripts.items || [];
    state.scriptTree = undefined;
    renderMetrics();
    renderScripts();
    toast('脚本已删除');
  } catch (error) {
    toast(formatError(error));
  }
}

async function batchRunScripts() {
  const paths = [...state.selectedScriptPaths];
  if (!paths.length) return;
  if (!await confirmAction({
    title: '批量运行脚本',
    message: `确认按顺序运行选中的 ${paths.length} 个脚本吗？`,
    details: paths.join('\n'),
    okText: '批量运行'
  })) return;
  try {
    paths.forEach((scriptPath) => state.launchingScriptPaths.add(scriptPath));
    toast(`正在启动 ${paths.length} 个脚本`);
    let lastRunId;
    for (const scriptPath of paths) {
      const result = await api.runScriptOnce({
        name: scriptPath.split('/').pop() || '脚本批量运行',
        scriptPath,
        cwd: 'data',
        waitForCompletion: false,
        timeoutMs: 30000
      });
      lastRunId = result.runId || result.data?.runId || lastRunId;
    }
    await refreshTasksAndRuns();
    renderRuns();
    if (lastRunId) {
      await showPage('log');
      await showRunLog(lastRunId);
    }
    toast(`已启动 ${paths.length} 个脚本，日志正在实时刷新`);
  } catch (error) {
    toast(formatError(error));
  } finally {
    paths.forEach((scriptPath) => state.launchingScriptPaths.delete(scriptPath));
  }
}

async function batchDeleteScripts() {
  const paths = [...state.selectedScriptPaths];
  if (!paths.length) return;
  if (!await confirmAction({
    title: '批量删除脚本',
    message: `确定删除选中的 ${paths.length} 个脚本吗？`,
    details: paths.join('\n'),
    okText: '批量删除',
    tone: 'danger'
  })) return;
  try {
    await api.deleteScripts(paths);
    state.selectedScriptPaths.clear();
    if (paths.includes(state.currentScriptPath)) {
      state.currentScriptPath = '';
      els.scriptPathInput.value = '';
      els.scriptEditor.value = '';
    }
    await refreshScripts();
    toast(`已删除 ${paths.length} 个脚本`);
  } catch (error) {
    toast(formatError(error));
  }
}

async function refreshDependencies() {
  const dependencies = await api.listDependencies();
  state.dependencies = dependencies.items || [];
  state.dependencyHistory = dependencies.history || [];
  renderDependencies();
}

function renderDependencies() {
  if (!state.dependencies.length) {
    setHtml(els.dependencyTable, '<div class="empty">暂无手动安装依赖。脚本缺依赖时也会自动安装到 data/node_modules。</div>');
  } else {
    setHtml(els.dependencyTable, `
      <table class="data-table">
        <thead><tr><th style="width: 280px">名称</th><th>版本</th><th style="width: 120px">操作</th></tr></thead>
        <tbody>
          ${state.dependencies.map((item) => `
            <tr>
              <td class="name-col">${escapeHtml(item.name)}</td>
              <td class="mono">${escapeHtml(String(item.version))}</td>
              <td><button class="link-button red" data-remove-dependency="${escapeAttr(item.name)}">卸载</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `);
  }

  setHtml(els.dependencyHistory, state.dependencyHistory.length
    ? state.dependencyHistory.map((item) => `
      <div class="timeline-item">
        <span>${escapeHtml(actionName(item.action))}: ${escapeHtml(item.name)}</span>
        <small>${escapeHtml(item.status)} · ${escapeHtml(formatDateTime(item.createdAt))}</small>
      </div>
    `).join('')
    : '<div class="empty">暂无依赖操作记录</div>');
}

function handleDependencyTableClick(event) {
  const button = event.target.closest('[data-remove-dependency]');
  if (button) removeDependency(button.dataset.removeDependency);
}

async function installDependency() {
  const name = readValue('dependencyNameInput');
  if (!name) {
    toast('请输入依赖名称');
    return;
  }
  if (state.installingDependency) return;
  try {
    state.installingDependency = true;
    els.installDependencyButton.disabled = true;
    els.installDependencyButton.textContent = '安装中...';
    toast(`正在安装依赖: ${name}`, { tone: 'info', persist: true });
    const result = await api.installDependency(name);
    state.dependencies = result.items || [];
    state.dependencyHistory = result.history || [];
    els.dependencyNameInput.value = '';
    renderDependencies();
    toast(`依赖安装完成: ${name}`, { tone: 'success', durationMs: 7000 });
  } catch (error) {
    toast(formatError(error), { tone: 'error', durationMs: 9000 });
  } finally {
    state.installingDependency = false;
    els.installDependencyButton.disabled = false;
    els.installDependencyButton.textContent = '安装依赖';
  }
}

async function removeDependency(name) {
  if (!await confirmAction({
    title: '卸载依赖',
    message: `确定卸载依赖「${name}」吗？`,
    okText: '卸载',
    tone: 'danger'
  })) return;
  try {
    const result = await api.removeDependency(name);
    state.dependencies = result.items || [];
    state.dependencyHistory = result.history || [];
    renderDependencies();
    toast('依赖已卸载');
  } catch (error) {
    toast(formatError(error));
  }
}

function renderRuns() {
  if (!state.runs.length) {
    setHtml(els.runList, '<div class="empty">暂无运行记录</div>');
    return;
  }
  const groups = groupRunsByScript(state.runs);
  setHtml(els.runList, `
    <div class="run-groups">
      ${groups.map((group) => `
        <section class="run-group">
          <div class="run-group-header">
            <strong title="${escapeAttr(group.title)}">${escapeHtml(group.title)}</strong>
            <small title="${escapeAttr(group.subtitle)}">${escapeHtml(group.subtitle)} · ${group.runs.length} 次</small>
          </div>
          ${group.runs.map((run) => `
            <button class="file-item run-item ${state.currentRunId === run.id ? 'active' : ''}" data-run-id="${escapeAttr(run.id)}">
              <span class="run-item-main">
                <strong>${escapeHtml(formatDateTime(run.startedAt))}</strong>
                <small>${escapeHtml(formatTrigger(run.trigger))} · ${escapeHtml(formatDuration(run.durationMs))}</small>
              </span>
              <span class="tag ${escapeAttr(statusTagClass(run.status))}">${escapeHtml(formatStatus(run.status))}</span>
            </button>
          `).join('')}
        </section>
      `).join('')}
    </div>
  `);
}

function renderRunsIfVisible() {
  if (state.activePage === 'log') renderRuns();
}

function handleRunListClick(event) {
  const button = event.target.closest('[data-run-id]');
  if (button) showRunLog(button.dataset.runId);
}

async function refreshRuns() {
  await refreshTasksAndRuns();
  renderMetrics();
  renderRuns();
  if (state.currentRunId) await showRunLog(state.currentRunId);
}

async function showRunLog(runId, options = {}) {
  stopLogRefresh();
  const run = await renderRunLog(runId, options);
  if (run?.status === 'running') startLogRefresh(runId);
}

async function renderRunLog(runId, options = {}) {
  try {
    const shouldAutoScroll = isLogViewerNearBottom();
    const [run, log] = await Promise.all([
      api.getRun(runId),
      api.getRunLog(runId, 'combined')
    ]);
    upsertRunRecord(run);
    state.currentRunId = runId;
    const task = state.tasks.find((item) => item.id === run.taskId);
    const display = getRunDisplayInfo(run, task);
    const statusSuffix = run.status === 'running' ? ' · 实时刷新中' : '';
    els.logTitle.textContent = display.title;
    els.logMeta.textContent = `${formatStatus(run.status)}${statusSuffix} · ${formatDateTime(run.startedAt)} · ${formatDuration(run.durationMs)} · ${formatTrigger(run.trigger)} · ${display.subtitle}`;
    const text = log.text || (run.status === 'running' ? '运行中，等待脚本输出...' : '日志为空');
    const changed = els.logViewer.textContent !== text;
    if (changed) {
      els.logViewer.textContent = text;
      if (shouldAutoScroll || run.status === 'running') {
        els.logViewer.scrollTop = els.logViewer.scrollHeight;
      }
    }
    renderRuns();
    if (run.status !== 'running') {
      const refreshes = [refreshTasksAndRuns()];
      if (run.trigger === 'subscription') {
        refreshes.push(refreshSubscriptions(), refreshScripts(), refreshQinglongOverview());
      }
      await Promise.all(refreshes);
      renderMetrics();
      renderTasks();
      if (run.trigger === 'subscription') {
        renderSubscriptions();
        renderScripts();
      }
      renderRuns();
    }
    return run;
  } catch (error) {
    if (!options.silent) toast(formatError(error));
    return undefined;
  }
}

async function copyCurrentLog() {
  await api.copyText(els.logViewer.textContent || '');
  toast('日志已复制到剪贴板');
}

async function refreshStartupStatus() {
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

async function loadAppearanceSettings() {
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

function applySettings(settings) {
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
    sort: normalizeTaskSort(crontab.sort),
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

async function saveCrontabSettings(patch = {}) {
  const nextCrontab = {
    ...(state.settings?.crontab || {}),
    activeViewId: state.settings?.crontab?.activeViewId || 'all',
    pageSize: state.taskPageSize,
    sort: normalizeTaskSort(state.taskSort),
    views: getCrontabViews(),
    ...patch
  };
  const saved = await api.saveSettings(mergeSettings({ crontab: nextCrontab }));
  state.settings = saved;
  state.taskPageSize = saved.crontab.pageSize;
  state.taskSort = normalizeTaskSort(saved.crontab.sort);
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

function startLogRefresh(runId) {
  stopLogRefresh();
  logRefreshTimer = setInterval(async () => {
    if (state.currentRunId !== runId) {
      stopLogRefresh();
      return;
    }
    const run = await renderRunLog(runId, { silent: true });
    if (!run || run.status !== 'running') {
      stopLogRefresh();
    }
  }, 1000);
}

function stopLogRefresh() {
  if (!logRefreshTimer) return;
  clearInterval(logRefreshTimer);
  logRefreshTimer = undefined;
}

function isLogViewerNearBottom() {
  if (!els.logViewer) return true;
  return els.logViewer.scrollHeight - els.logViewer.scrollTop - els.logViewer.clientHeight < 60;
}

function upsertRunRecord(run) {
  if (!run?.id) return;
  const index = state.runs.findIndex((item) => item.id === run.id);
  if (index >= 0) {
    state.runs[index] = { ...state.runs[index], ...run };
  } else {
    state.runs.unshift(run);
  }
  state.runs = state.runs.toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function groupRunsByScript(runs) {
  const sorted = [...runs].toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const groups = new Map();
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  for (const run of sorted) {
    const task = tasksById.get(run.taskId);
    const display = getRunDisplayInfo(run, task);
    const key = display.key;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: display.title,
        subtitle: display.subtitle,
        latestAt: run.startedAt,
        runs: []
      });
    }
    groups.get(key).runs.push(run);
  }
  return [...groups.values()].toSorted((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
}

function getRunDisplayInfo(run, task) {
  if (run.trigger === 'subscription') {
    return {
      key: run.taskId || run.scriptPath || run.id,
      title: run.name || '订阅运行',
      subtitle: run.scriptPath || `运行 ID: ${run.id}`
    };
  }

  const scriptPath = task?.scriptPath || run.scriptPath || '';
  const name = task?.name || run.name || scriptPath.split('/').pop() || run.id;
  return {
    key: scriptPath || run.taskId || run.id,
    title: name,
    subtitle: scriptPath || `运行 ID: ${run.id}`
  };
}

function latestRunForTask(taskId) {
  return state.runs.find((run) => run.taskId === taskId);
}

function formatSchedule(task) {
  if (task.cronExpression === '@once') return '手动运行';
  if (task.cronExpression === '@boot') return '开机运行';
  return task.cronExpression || '-';
}

function formatScheduleTitle(task) {
  const schedules = [formatSchedule(task), ...(task.extraSchedules || [])].filter(Boolean);
  return schedules.join('\n');
}

function formatNextRun(task) {
  if (!task.enabled) return '-';
  if (task.cronExpression === '@once') return '仅手动';
  if (task.cronExpression === '@boot') return '下次开机';
  return estimateNextRun(task.cronExpression);
}

function estimateNextRun(cron) {
  if (!cron) return '-';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return '-';
  const now = new Date();
  for (let i = 1; i <= 1440; i += 1) {
    const next = new Date(now.getTime() + i * 60 * 1000);
    next.setSeconds(0, 0);
    if (cronPartMatches(parts[0], next.getMinutes(), 0, 59) &&
      cronPartMatches(parts[1], next.getHours(), 0, 23) &&
      cronPartMatches(parts[2], next.getDate(), 1, 31) &&
      cronPartMatches(parts[3], next.getMonth() + 1, 1, 12) &&
      cronPartMatches(parts[4], next.getDay() || 7, 1, 7)) {
      return formatDateTime(next.toISOString());
    }
  }
  return '24 小时后';
}

function cronPartMatches(part, value, min, max) {
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

function renderLabels(labels = []) {
  return labels.length
    ? labels.map((label) => `<span class="tag amber">${escapeHtml(label)}</span>`).join('')
    : '<span class="muted">-</span>';
}

function upsertSubscription(subscription) {
  if (!subscription?.id) return;
  const index = state.subscriptions.findIndex((item) => item.id === subscription.id);
  if (index >= 0) {
    state.subscriptions[index] = { ...state.subscriptions[index], ...subscription };
  } else {
    state.subscriptions.unshift(subscription);
  }
  renderSubscriptions();
}

async function refreshAfterSubscriptionRun(runId) {
  if (!runId || !state.completedSubscriptionRunRefreshIds.has(runId)) {
    await Promise.all([
      refreshSubscriptions(),
      refreshScripts(),
      refreshQinglongOverview(),
      refreshTasksAndRuns()
    ]);
    if (runId) state.completedSubscriptionRunRefreshIds.add(runId);
  }

  renderMetrics();
  renderTasks();
  renderSubscriptions();
  renderScripts();
  renderRunsIfVisible();
}

function getSubscriptionName(id) {
  const subscription = state.subscriptions.find((item) => item.id === id);
  return subscription?.name || id || '未命名订阅';
}

function formatSubscriptionRunSuccess(result, fallbackName) {
  const name = result?.name || fallbackName || '订阅';
  const target = result?.localPath ? `，目录：${result.localPath}` : '';
  const detail = result?.lastResult ? `，${result.lastResult}` : '';
  return `订阅运行成功：${name}${detail}${target}`;
}

function setSubscriptionRunStatus(message, tone = 'info') {
  if (!els.subscriptionRunStatus) return;
  els.subscriptionRunStatus.textContent = message;
  els.subscriptionRunStatus.dataset.tone = tone;
  els.subscriptionRunStatus.hidden = false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keepExistingSelection(selection, ids) {
  const idSet = new Set(ids);
  return new Set([...selection].filter((id) => idSet.has(id)));
}

function toggleSet(set, value, selected) {
  if (selected) set.add(value);
  else set.delete(value);
}

function readValue(id) {
  return els[id].value.trim();
}

function readLines(id) {
  return els[id].value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readInteger(id, fallback) {
  const value = Number(els[id].value);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readBoundedInteger(id, min, max, fallback) {
  const value = Number(els[id].value);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readJsonObject(id, label) {
  const raw = els[id].value.trim();
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value;
}

function formatStatus(status) {
  const map = {
    running: '运行中',
    success: '成功',
    failed: '失败',
    timeout: '超时',
    stopped: '已停止'
  };
  return map[status] || status || '-';
}

function statusTagClass(status) {
  const map = {
    running: 'blue',
    success: 'green',
    failed: 'red',
    timeout: 'amber',
    stopped: 'gray'
  };
  return map[status] || 'gray';
}

function formatTrigger(trigger) {
  const map = {
    manual: '手动',
    api: '接口',
    schedule: '定时',
    subscription: '订阅'
  };
  return map[trigger] || trigger || '-';
}

function formatDuration(durationMs) {
  if (durationMs === undefined || durationMs === null) return '-';
  if (durationMs < 1000) return `${durationMs} 毫秒`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${restSeconds} 秒`;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatStartupStatus(status) {
  if (!status.supported) return status.message || '当前系统不支持开机启动';
  const prefix = status.enabled ? '已启用' : '未启用';
  const runLevel = status.runLevel ? `，权限: ${status.runLevel}` : '';
  const execute = status.execute ? `，程序: ${status.execute}` : '';
  return `${prefix}${runLevel}${execute}。${status.message || ''}`;
}

function formatError(error) {
  return [
    `错误码: ${error.code || 'UNKNOWN'}`,
    `错误信息: ${error.message}`,
    error.details ? `详细信息: ${JSON.stringify(error.details, null, 2)}` : undefined
  ].filter(Boolean).join('\n');
}

function maskValue(value) {
  const text = String(value || '');
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}••••${text.slice(-4)}`;
}

function actionName(action) {
  return action === 'remove' ? '卸载' : '安装';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

function toast(message, options = {}) {
  els.toast.textContent = String(message || '');
  els.toast.dataset.tone = options.tone || 'info';
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  if (!options.persist) {
    toast.timer = setTimeout(() => {
      els.toast.hidden = true;
    }, options.durationMs || 3600);
  }
}

function showFatalError(error) {
  const text = formatError(error);
  document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:20px;color:#e05260">${escapeHtml(text)}</pre>`;
}

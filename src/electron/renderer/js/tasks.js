// 定时任务页：表格渲染、排序视图分页、运行/停止/启停/置顶/标签/删除、详情与任务日志弹窗。
import { api, els, state } from './context.js';
import { escapeAttr, escapeHtml, formatDateTime, formatDuration, formatError, formatStatus, formatTrigger, keepExistingSelection, readLines, readValue, toggleSet } from './utils.js';
import { estimateNextRun } from './cron.js';
import { closeFloatingMenu, confirmAction, renderMetrics, toast } from './ui.js';
import { latestRunForTask, refreshTasksAndRuns, refreshTasksOnly } from './data.js';
import { fetchAndDisplayRunLog } from './log-viewer.js';
import { getRunDisplayInfo, renderRuns, renderRunsIfVisible, showRunLog } from './runs.js';
import { loadScript } from './scripts.js';
import { getCrontabViews, saveCrontabSettings } from './settings.js';
import { openTaskModal } from './task-modal.js';
import { showPage } from './app.js';

let taskLogRefreshTimer;

export function bindTasks() {
  els.newTaskButton.addEventListener('click', () => openTaskModal());
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
  els.labelForm.addEventListener('submit', handleLabelSubmit);
  els.removeLabelsButton.addEventListener('click', () => updateSelectedLabels('remove'));
  els.viewForm.addEventListener('submit', handleViewSubmit);
  els.createViewButton.addEventListener('click', () => openViewModal());
  els.viewManageTable.addEventListener('click', handleViewManageClick);
  els.copyTaskLogButton.addEventListener('click', () => copyTaskLog());
  els.openTaskLogPageButton.addEventListener('click', () => openCurrentTaskLogPage());
  els.taskLogModal.addEventListener('close', () => stopTaskLogRefresh());
}

export function renderTasks() {
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
    els.taskTable.innerHTML = `<div class="empty">暂无定时任务，点击“新建任务”创建第一个脚本任务。</div>`;
    updateTaskButtons();
    return;
  }

  els.taskTable.innerHTML = `
    <table class="data-table ql-cron-table">
      <thead>
        <tr>
          <th class="check-col"><input id="selectAllTasksInput" type="checkbox" ${allSelected ? 'checked' : ''}></th>
          <th style="width: 150px">${renderSortHeader('name', '名称')}</th>
          <th style="width: 260px">${renderSortHeader('scriptPath', '命令/脚本')}</th>
          <th style="width: 108px">${renderSortHeader('status', '状态')}</th>
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
  `;

  updateTaskButtons();
}

function renderTaskRow(task) {
  const selected = state.selectedTaskIds.has(task.id);
  const isMutating = state.taskMutatingIds.has(task.id);
  const rowClass = [selected ? 'selected' : '', task.pinned ? 'pinned-row' : '', isMutating ? 'mutating-row' : ''].filter(Boolean).join(' ');
  const status = isMutating
    ? { value: 'mutating', label: '处理中', className: 'amber' }
    : task.statusInfo;
  const isLaunching = state.launchingTaskIds.has(task.id);
  const isBusy = isLaunching || task.statusInfo.value === 'running';
  return `
    <tr class="${rowClass}" data-task-row="${escapeAttr(task.id)}">
      <td class="check-col"><input type="checkbox" data-task-check="${escapeAttr(task.id)}" ${selected ? 'checked' : ''}></td>
      <td class="name-col" title="${escapeAttr(task.name)}"><button class="link-button name-link" data-detail-task="${escapeAttr(task.id)}">${task.pinned ? '<span class="pin-text">置顶</span>' : ''}${escapeHtml(task.name)}</button></td>
      <td class="path-col" title="${escapeAttr(task.scriptPath)}"><button class="link-button path-link" data-open-task-script="${escapeAttr(task.id)}">${escapeHtml(task.scriptPath)}</button></td>
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
  const actions = [
    ['data-task-sort', (value) => changeTaskSort(value)],
    ['data-detail-task', (value) => openTaskDetail(value)],
    ['data-open-task-script', (value) => openTaskScript(value)],
    ['data-run-task', (value) => runTask(value)],
    ['data-stop-task', (value) => stopTask(value)],
    ['data-log-task', (value) => showTaskLog(value)],
    ['data-more-task', (value, target) => openTaskMoreMenu(value, target)]
  ];
  for (const [attribute, action] of actions) {
    const target = event.target.closest(`[${attribute}]`);
    if (target) {
      event.stopPropagation();
      action(target.getAttribute(attribute), target);
      return;
    }
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
  const { field, direction } = state.taskSort || { field: 'pinned', direction: 'DESC' };
  const factor = direction === 'ASC' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned && field !== 'pinned') return a.pinned ? -1 : 1;
    const result = compareTaskField(a, b, field);
    if (result !== 0) return result * factor;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function compareTaskField(a, b, field) {
  if (field === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  if (field === 'scriptPath') return String(a.scriptPath || '').localeCompare(String(b.scriptPath || ''), 'zh-CN');
  if (field === 'status') return String(a.statusInfo.label || '').localeCompare(String(b.statusInfo.label || ''), 'zh-CN');
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
  const direction = state.taskSort?.field === field && state.taskSort.direction === 'ASC' ? 'DESC' : 'ASC';
  state.taskSort = { field, direction };
  await saveCrontabSettings();
  renderTasks();
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
  els.taskViewTabs.innerHTML = views.map((view) => `
    <button class="view-tab ${view.id === activeId ? 'active' : ''}" data-task-view="${escapeAttr(view.id)}">${escapeHtml(view.name)}</button>
  `).join('');
}

async function handleTaskViewTabsClick(event) {
  const button = event.target.closest('[data-task-view]');
  if (!button) return;
  state.selectedTaskIds.clear();
  state.taskPage = 1;
  await saveCrontabSettings({ activeViewId: button.dataset.taskView });
  renderTasks();
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

// 乐观更新：先改本地状态渲染，失败时回滚快照。
async function mutateTasksOptimistically(ids, patch, action, successMessage) {
  const snapshots = snapshotTasks(ids);
  patchTaskRows(ids, patch);
  setTaskMutating(ids, true);
  renderTasks();
  try {
    for (const id of ids) {
      await action(id);
    }
    setTaskMutating(ids, false);
    renderTasks();
    toast(successMessage);
    return true;
  } catch (error) {
    restoreTaskSnapshots(snapshots);
    setTaskMutating(ids, false);
    if (ids.length > 1) await refreshTasksOnly().catch(() => undefined);
    renderTasks();
    toast(formatError(error));
    return false;
  }
}

export async function setTaskEnabled(taskId, enabled) {
  if (!state.tasks.some((item) => item.id === taskId)) return;
  await mutateTasksOptimistically(
    [taskId],
    { enabled },
    (id) => api.setTaskEnabled(id, enabled),
    enabled ? '任务已启用' : '任务已禁用'
  );
  if (state.detailTaskId === taskId && els.taskDetailModal.open) {
    await refreshTaskDetail(taskId);
  }
}

async function batchSetTasksEnabled(enabled) {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  await mutateTasksOptimistically(
    ids,
    { enabled },
    (id) => api.setTaskEnabled(id, enabled),
    enabled ? `已启用 ${ids.length} 个任务` : `已禁用 ${ids.length} 个任务`
  );
}

export async function setTaskPinned(taskId, pinned) {
  if (!state.tasks.some((item) => item.id === taskId)) return;
  await mutateTasksOptimistically(
    [taskId],
    { pinned },
    (id) => api.setTaskPinned(id, pinned),
    pinned ? '任务已置顶' : '已取消置顶'
  );
  if (state.detailTaskId === taskId && els.taskDetailModal.open) {
    await refreshTaskDetail(taskId);
  }
}

async function batchSetTasksPinned(pinned) {
  const ids = [...state.selectedTaskIds];
  if (!ids.length) return;
  await mutateTasksOptimistically(
    ids,
    { pinned },
    (id) => api.setTaskPinned(id, pinned),
    pinned ? `已置顶 ${ids.length} 个任务` : `已取消置顶 ${ids.length} 个任务`
  );
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

export async function openTaskLogModal(runId, taskId) {
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
    const run = await fetchAndDisplayRunLog(runId, els.taskLogViewer, '运行中，等待脚本输出...');
    const task = state.tasks.find((item) => item.id === (run.taskId || state.currentTaskLogTaskId));
    const display = getRunDisplayInfo(run, task);
    const statusSuffix = run.status === 'running' ? ' · 实时刷新中' : '';
    els.taskLogTitle.textContent = `任务日志：${display.title}`;
    els.taskLogMeta.textContent = `${formatStatus(run.status)}${statusSuffix} · ${formatDateTime(run.startedAt)} · ${formatDuration(run.durationMs)} · ${formatTrigger(run.trigger)} · ${display.subtitle}`;
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
    ['命令/脚本', task.scriptPath],
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

function renderLabels(labels = []) {
  return labels.length
    ? labels.map((label) => `<span class="tag amber">${escapeHtml(label)}</span>`).join('')
    : '<span class="muted">-</span>';
}

export function formatSchedule(task) {
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

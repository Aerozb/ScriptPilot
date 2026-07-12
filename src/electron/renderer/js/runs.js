// 日志管理页：运行记录分组列表、日志查看器、直接运行弹窗。
import { api, els, state } from './context.js';
import { escapeAttr, escapeHtml, formatDateTime, formatDuration, formatError, formatStatus, formatTrigger, readInteger, readJsonObject, readLines, readValue, statusTagClass } from './utils.js';
import { renderMetrics, toast } from './ui.js';
import { refreshQinglongOverview, refreshTasksAndRuns } from './data.js';
import { fetchAndDisplayRunLog } from './log-viewer.js';
import { renderTasks } from './tasks.js';
import { refreshSubscriptions, renderSubscriptions } from './subscriptions.js';
import { refreshScripts, renderScripts } from './scripts.js';
import { showPage } from './app.js';

let logRefreshTimer;

export function bindRuns() {
  els.quickRunButton.addEventListener('click', () => openRunModal());
  els.runForm.addEventListener('submit', handleRunSubmit);
  els.refreshRunsButton.addEventListener('click', () => refreshRuns());
  els.runList.addEventListener('click', handleRunListClick);
  els.copyLogButton.addEventListener('click', () => copyCurrentLog());
}

export function renderRuns() {
  if (!state.runs.length) {
    els.runList.innerHTML = '<div class="empty">暂无运行记录</div>';
    return;
  }
  const groups = groupRunsByScript(state.runs);
  els.runList.innerHTML = `
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
  `;
}

export function renderRunsIfVisible() {
  if (state.activePage === 'log') renderRuns();
}

function handleRunListClick(event) {
  const button = event.target.closest('[data-run-id]');
  if (button) showRunLog(button.dataset.runId);
}

export async function refreshRuns() {
  await refreshTasksAndRuns();
  renderMetrics();
  renderRuns();
  if (state.currentRunId) await showRunLog(state.currentRunId);
}

export async function showRunLog(runId, options = {}) {
  stopLogRefresh();
  const run = await renderRunLog(runId, options);
  if (run?.status === 'running') startLogRefresh(runId);
}

export async function renderRunLog(runId, options = {}) {
  try {
    const run = await fetchAndDisplayRunLog(runId, els.logViewer, '运行中，等待脚本输出...');
    state.currentRunId = runId;
    const task = state.tasks.find((item) => item.id === run.taskId);
    const display = getRunDisplayInfo(run, task);
    const statusSuffix = run.status === 'running' ? ' · 实时刷新中' : '';
    els.logTitle.textContent = display.title;
    els.logMeta.textContent = `${formatStatus(run.status)}${statusSuffix} · ${formatDateTime(run.startedAt)} · ${formatDuration(run.durationMs)} · ${formatTrigger(run.trigger)} · ${display.subtitle}`;
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

async function copyCurrentLog() {
  await api.copyText(els.logViewer.textContent || '');
  toast('日志已复制到剪贴板');
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

export function getRunDisplayInfo(run, task) {
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

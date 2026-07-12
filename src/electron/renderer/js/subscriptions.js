// 订阅管理页：列表、运行（后台+日志弹窗实时刷新）、批量操作、编辑弹窗。
import { api, els, state } from './context.js';
import { delay, escapeAttr, escapeHtml, formatDateTime, formatDuration, formatError, formatStatus, keepExistingSelection, readValue, toggleSet } from './utils.js';
import { confirmAction, renderMetrics, toast } from './ui.js';
import { refreshQinglongOverview, refreshTasksAndRuns, upsertRunRecord } from './data.js';
import { fetchAndDisplayRunLog } from './log-viewer.js';
import { renderRuns, renderRunLog, renderRunsIfVisible, showRunLog } from './runs.js';
import { refreshScripts, renderScripts } from './scripts.js';
import { showPage } from './app.js';

let subscriptionLogRefreshTimer;

export function bindSubscriptions() {
  els.newSubscriptionButton.addEventListener('click', () => openSubscriptionModal());
  els.subscriptionForm.addEventListener('submit', handleSubscriptionSubmit);
  els.subscriptionTable.addEventListener('click', handleSubscriptionTableClick);
  els.subscriptionTable.addEventListener('change', handleSubscriptionTableChange);
  els.batchRunSubscriptionsButton.addEventListener('click', () => batchRunSubscriptions());
  els.batchDeleteSubscriptionsButton.addEventListener('click', () => batchDeleteSubscriptions());
  els.copySubscriptionLogButton.addEventListener('click', () => copySubscriptionLog());
  els.openSubscriptionLogPageButton.addEventListener('click', () => openCurrentSubscriptionLogPage());
  els.subscriptionLogModal.addEventListener('close', () => stopSubscriptionLogRefresh());
}

export function renderSubscriptions() {
  state.selectedSubscriptionIds = keepExistingSelection(state.selectedSubscriptionIds, state.subscriptions.map((item) => item.id));
  const rows = state.subscriptions;
  const allSelected = rows.length > 0 && rows.every((item) => state.selectedSubscriptionIds.has(item.id));
  if (!rows.length) {
    els.subscriptionTable.innerHTML = `<div class="empty">暂无订阅，点击“新建订阅”添加。</div>`;
    updateSubscriptionButtons();
    return;
  }

  els.subscriptionTable.innerHTML = `
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
  `;
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

export async function refreshSubscriptions() {
  const subscriptions = await api.listSubscriptions();
  state.subscriptions = subscriptions.items || [];
  renderSubscriptions();
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
    const run = await fetchAndDisplayRunLog(runId, els.subscriptionLogViewer, '运行中，等待订阅输出...');
    const subscription = state.subscriptions.find((item) => item.lastRunId === runId || item.id === state.currentSubscriptionLogSubscriptionId);
    const statusSuffix = run.status === 'running' ? ' · 实时刷新中' : '';
    els.subscriptionLogTitle.textContent = subscription?.name ? `订阅日志：${subscription.name}` : (run.name || '订阅日志');
    els.subscriptionLogMeta.textContent = `${formatStatus(run.status)}${statusSuffix} · ${formatDateTime(run.startedAt)} · ${formatDuration(run.durationMs)} · ${run.scriptPath || '-'}`;
    renderRunsIfVisible();
    if (run.status !== 'running') {
      await Promise.all([
        refreshSubscriptions(),
        refreshScripts(),
        refreshQinglongOverview(),
        refreshTasksAndRuns()
      ]);
      renderMetrics();
      renderSubscriptions();
      renderScripts();
      renderRunsIfVisible();
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

    await Promise.all([
      refreshSubscriptions(),
      refreshScripts(),
      refreshQinglongOverview(),
      refreshTasksAndRuns()
    ]);
    renderMetrics();
    renderSubscriptions();
    renderScripts();
    renderRunsIfVisible();

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

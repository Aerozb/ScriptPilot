// 环境变量页：列表（遮罩值）、搜索、批量启停删、编辑弹窗。
import { api, els, state } from './context.js';
import { escapeAttr, escapeHtml, formatDateTime, formatError, keepExistingSelection, maskValue, readValue, toggleSet } from './utils.js';
import { confirmAction, renderMetrics, toast } from './ui.js';

let envRenderFrame;

export function bindEnvs() {
  els.newEnvButton.addEventListener('click', () => openEnvModal());
  els.envForm.addEventListener('submit', handleEnvSubmit);
  els.envSearchInput.addEventListener('input', () => scheduleEnvRender());
  els.envTable.addEventListener('click', handleEnvTableClick);
  els.envTable.addEventListener('change', handleEnvTableChange);
  els.batchEnableEnvsButton.addEventListener('click', () => batchSetEnvsStatus('enabled'));
  els.batchDisableEnvsButton.addEventListener('click', () => batchSetEnvsStatus('disabled'));
  els.batchDeleteEnvsButton.addEventListener('click', () => batchDeleteEnvs());
}

export function renderEnvs() {
  const rows = getFilteredEnvs();
  state.selectedEnvIds = keepExistingSelection(state.selectedEnvIds, state.envs.map((item) => item.id));
  const allSelected = rows.length > 0 && rows.every((item) => state.selectedEnvIds.has(item.id));

  if (!rows.length) {
    els.envTable.innerHTML = `<div class="empty">暂无环境变量，点击“新建变量”添加。</div>`;
    updateEnvButtons();
    return;
  }

  els.envTable.innerHTML = `
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
  `;
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

export async function refreshEnvs() {
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

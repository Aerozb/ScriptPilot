// 依赖管理页：npm 依赖列表、安装/卸载、操作历史。
import { api, els, state } from './context.js';
import { actionName, escapeAttr, escapeHtml, formatDateTime, formatError, readValue } from './utils.js';
import { confirmAction, toast } from './ui.js';

export function bindDependencies() {
  els.installDependencyButton.addEventListener('click', () => installDependency());
  els.dependencyNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') installDependency();
  });
  els.dependencyTable.addEventListener('click', handleDependencyTableClick);
}

export async function refreshDependencies() {
  const dependencies = await api.listDependencies();
  state.dependencies = dependencies.items || [];
  state.dependencyHistory = dependencies.history || [];
  renderDependencies();
}

export function renderDependencies() {
  if (!state.dependencies.length) {
    els.dependencyTable.innerHTML = '<div class="empty">暂无手动安装依赖。脚本缺依赖时也会自动安装到 data/node_modules。</div>';
  } else {
    els.dependencyTable.innerHTML = `
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
    `;
  }

  els.dependencyHistory.innerHTML = state.dependencyHistory.length
    ? state.dependencyHistory.map((item) => `
      <div class="timeline-item">
        <span>${escapeHtml(actionName(item.action))}: ${escapeHtml(item.name)}</span>
        <small>${escapeHtml(item.status)} · ${escapeHtml(formatDateTime(item.createdAt))}</small>
      </div>
    `).join('')
    : '<div class="empty">暂无依赖操作记录</div>';
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

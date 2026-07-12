// 配置文件页：列表、编辑器、保存。
import { api, els, state } from './context.js';
import { escapeAttr, escapeHtml, formatBytes, formatDateTime, formatError } from './utils.js';
import { openPortableDirectory, toast } from './ui.js';

export function bindConfigs() {
  els.refreshConfigsButton.addEventListener('click', () => refreshConfigs());
  els.openConfigsDirButton.addEventListener('click', () => openPortableDirectory('data/configs'));
  els.openCurrentConfigDirButton.addEventListener('click', () => openPortableDirectory('data/configs'));
  els.saveConfigButton.addEventListener('click', () => saveCurrentConfig());
  els.configList.addEventListener('click', handleConfigListClick);
}

export function renderConfigs() {
  if (!state.configs.length) {
    els.configList.innerHTML = '<div class="empty">暂无配置文件</div>';
    return;
  }
  els.configList.innerHTML = state.configs.map((item) => `
    <button class="file-item ${state.currentConfigName === item.name ? 'active' : ''}" data-config-name="${escapeAttr(item.name)}">
      <strong>${escapeHtml(item.name)}</strong>
      <small>${escapeHtml(formatBytes(item.size))} · ${escapeHtml(formatDateTime(item.updatedAt))}</small>
    </button>
  `).join('');
}

function handleConfigListClick(event) {
  const button = event.target.closest('[data-config-name]');
  if (button) loadConfig(button.dataset.configName);
}

export async function refreshConfigs() {
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

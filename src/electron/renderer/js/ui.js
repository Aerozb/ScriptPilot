// 通用 UI：toast、确认弹窗、浮动菜单、指标卡、目录打开。
import { api, els, state } from './context.js';
import { escapeHtml, formatError } from './utils.js';

let toastTimer;

export function toast(message, options = {}) {
  els.toast.textContent = String(message || '');
  els.toast.dataset.tone = options.tone || 'info';
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  if (!options.persist) {
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, options.durationMs || 3600);
  }
}

export function showFatalError(error) {
  const text = formatError(error);
  document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:20px;color:#e05260">${escapeHtml(text)}</pre>`;
}

let pendingConfirmResolver;

export function confirmAction(options) {
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

export function resolveConfirm(value) {
  if (els.confirmModal.open) els.confirmModal.close();
  const resolver = pendingConfirmResolver;
  pendingConfirmResolver = undefined;
  resolver?.(value);
}

export function bindConfirmModal() {
  els.confirmCancelButton.addEventListener('click', () => resolveConfirm(false));
  els.confirmOkButton.addEventListener('click', () => resolveConfirm(true));
  els.confirmModal.addEventListener('cancel', (event) => {
    event.preventDefault();
    resolveConfirm(false);
  });
}

export function closeFloatingMenu() {
  document.querySelector('.floating-menu')?.remove();
}

export function renderMetrics() {
  if (els.metricTaskCount) els.metricTaskCount.textContent = String(state.tasks.length);
  if (els.metricRunCount) els.metricRunCount.textContent = String(state.runs.length);
  const enabledEnvCount = state.envs.filter((item) => item.status === 'enabled').length;
  if (els.metricEnvCount) els.metricEnvCount.textContent = `${enabledEnvCount}/${state.envs.length}`;
  if (els.metricScriptCount) els.metricScriptCount.textContent = String(state.scripts.length);
}

export async function openPortableDirectory(portablePath, kind = 'directory') {
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

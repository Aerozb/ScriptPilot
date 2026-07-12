// 日志查看器共用逻辑：拉取运行+日志并渲染，靠近底部时自动滚动。
import { api } from './context.js';
import { upsertRunRecord } from './data.js';

export async function fetchAndDisplayRunLog(runId, viewerEl, runningPlaceholder) {
  const shouldAutoScroll = isViewerNearBottom(viewerEl);
  const [run, log] = await Promise.all([
    api.getRun(runId),
    api.getRunLog(runId, 'combined')
  ]);
  upsertRunRecord(run);
  const text = log.text || (run.status === 'running' ? runningPlaceholder : '日志为空');
  if (viewerEl.textContent !== text) {
    viewerEl.textContent = text;
    if (shouldAutoScroll || run.status === 'running') {
      viewerEl.scrollTop = viewerEl.scrollHeight;
    }
  }
  return run;
}

export function isViewerNearBottom(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

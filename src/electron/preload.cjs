const { clipboard, contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    error.details = result.error.details;
    throw error;
  }

  return result.data;
}

contextBridge.exposeInMainWorld('scriptPilot', {
  getInfo: () => invoke('app:get-info'),
  copyText: (text) => clipboard.writeText(String(text || '')),
  openDataDir: () => invoke('app:open-data-dir'),
  openPortablePath: (input) => invoke('app:open-portable-path', input),
  checkForUpdates: () => invoke('app:check-updates'),
  downloadUpdate: (input) => invoke('app:download-update', input),
  openUpdatePage: (input) => invoke('app:open-update-page', input),
  runDemo: () => invoke('demo:run'),
  listTasks: () => invoke('task:list'),
  createTask: (input) => invoke('task:create', input),
  updateTask: (input) => invoke('task:update', input),
  setTaskEnabled: (taskId, enabled) => invoke('task:set-enabled', { taskId, enabled }),
  setTasksEnabled: (ids, enabled) => invoke('task:batch-set-enabled', { ids, enabled }),
  setTaskPinned: (taskId, pinned) => invoke('task:set-pinned', { taskId, pinned }),
  setTasksPinned: (ids, pinned) => invoke('task:batch-set-pinned', { ids, pinned }),
  updateTaskLabels: (input) => invoke('task:update-labels', input),
  deleteTask: (taskId) => invoke('task:delete', { taskId }),
  runTaskNow: (taskId, options = {}) => invoke('task:run-now', { taskId, ...options }),
  stopTaskRun: (taskId) => invoke('task:stop-run', { taskId }),
  runScriptOnce: (input) => invoke('script:run-once', input),
  listRuns: (input) => invoke('run:list', input),
  getRun: (runId) => invoke('run:get', { runId }),
  getRunLog: (runId, stream = 'combined') => invoke('run:get-log', { runId, stream }),
  getStartupStatus: () => invoke('startup:status'),
  enableStartup: () => invoke('startup:enable'),
  disableStartup: () => invoke('startup:disable'),
  getSettings: () => invoke('settings:get'),
  saveSettings: (input) => invoke('settings:save', input),
  cleanupLogsNow: () => invoke('logs:cleanup-now'),
  qlOverview: () => invoke('ql:overview'),
  listEnvs: () => invoke('ql:env:list'),
  saveEnv: (input) => invoke('ql:env:save', input),
  deleteEnvs: (ids) => invoke('ql:env:delete', { ids }),
  setEnvStatus: (ids, status) => invoke('ql:env:set-status', { ids, status }),
  listConfigs: () => invoke('ql:config:list'),
  getConfig: (name) => invoke('ql:config:get', { name }),
  saveConfig: (input) => invoke('ql:config:save', input),
  listScripts: () => invoke('ql:script:list'),
  getScript: (path) => invoke('ql:script:get', { path }),
  saveScript: (input) => invoke('ql:script:save', input),
  deleteScripts: (paths) => invoke('ql:script:delete', { paths }),
  listSubscriptions: () => invoke('ql:subscription:list'),
  saveSubscription: (input) => invoke('ql:subscription:save', input),
  deleteSubscriptions: (ids) => invoke('ql:subscription:delete', { ids }),
  runSubscription: (id, options = {}) => invoke('ql:subscription:run', { id, ...options }),
  listDependencies: () => invoke('ql:dependency:list'),
  installDependency: (name) => invoke('ql:dependency:install', { name }),
  removeDependency: (name) => invoke('ql:dependency:remove', { name })
});

// 渲染进程共享上下文：preload API、全局状态、DOM 引用。
export const api = window.scriptPilot;

export const state = {
  info: undefined,
  tasks: [],
  runs: [],
  overview: undefined,
  envs: [],
  configs: [],
  scripts: [],
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
  currentSubscriptionLogSubscriptionId: '',
  detailTaskId: '',
  detailTab: 'log',
  activePage: 'crontab'
};

export const els = {};

export function bindElements() {
  for (const node of document.querySelectorAll('[id]')) {
    els[node.id] = node;
  }
}

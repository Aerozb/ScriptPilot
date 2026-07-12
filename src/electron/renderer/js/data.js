// 数据层：拉取后端数据到 state；不做渲染。
import { api, state } from './context.js';
import { renderMetrics } from './ui.js';

export async function refreshTasksAndRuns() {
  const [tasks, runs] = await Promise.all([
    api.listTasks(),
    api.listRuns({ limit: 200 })
  ]);
  state.tasks = tasks.items || [];
  state.runs = runs.items || [];
}

export async function refreshTasksOnly() {
  const tasks = await api.listTasks();
  state.tasks = tasks.items || [];
}

export async function refreshQinglongData() {
  const [overview, envs, configs, scripts, subscriptions, dependencies] = await Promise.all([
    api.qlOverview(),
    api.listEnvs(),
    api.listConfigs(),
    api.listScripts(),
    api.listSubscriptions(),
    api.listDependencies()
  ]);
  state.overview = overview;
  state.envs = envs.items || [];
  state.configs = configs.items || [];
  state.scripts = scripts.items || [];
  state.subscriptions = subscriptions.items || [];
  state.dependencies = dependencies.items || [];
  state.dependencyHistory = dependencies.history || [];
}

export async function refreshQinglongOverview() {
  state.overview = await api.qlOverview();
  renderMetrics();
}

export function upsertRunRecord(run) {
  if (!run?.id) return;
  const index = state.runs.findIndex((item) => item.id === run.id);
  if (index >= 0) {
    state.runs[index] = { ...state.runs[index], ...run };
  } else {
    state.runs.unshift(run);
  }
  state.runs = state.runs.toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export function latestRunForTask(taskId) {
  return state.runs.find((run) => run.taskId === taskId);
}

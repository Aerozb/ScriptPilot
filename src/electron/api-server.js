import http from 'node:http';
import { URL } from 'node:url';
import { createTaskCommand } from '../main/modules/tasks/application/commands/create-task.command.js';
import { updateTaskCommand } from '../main/modules/tasks/application/commands/update-task.command.js';
import { deleteTaskCommand } from '../main/modules/tasks/application/commands/delete-task.command.js';
import { setTaskEnabledCommand } from '../main/modules/tasks/application/commands/set-task-enabled.command.js';
import { setTaskPinnedCommand } from '../main/modules/tasks/application/commands/set-task-pinned.command.js';
import { updateTaskLabelsCommand } from '../main/modules/tasks/application/commands/update-task-labels.command.js';
import { listTasksQuery } from '../main/modules/tasks/application/queries/list-tasks.query.js';
import { runTaskNowCommand } from '../main/modules/runs/application/commands/run-task-now.command.js';
import { stopTaskRunCommand } from '../main/modules/runs/application/commands/stop-task-run.command.js';
import { runScriptOnceCommand } from '../main/modules/runs/application/commands/run-script-once.command.js';
import { getRunQuery } from '../main/modules/runs/application/queries/get-run.query.js';
import { getRunLogQuery } from '../main/modules/runs/application/queries/get-run-log.query.js';
import { listRunsQuery } from '../main/modules/runs/application/queries/list-runs.query.js';
import { disableStartupTask, enableStartupTask, getStartupTaskStatus } from '../main/modules/startup/infrastructure/windows-startup-task.js';
import { toAppError } from '../main/shared/errors/app-error.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

/*
 * 声明式路由表：[方法, 路径模式, 处理函数]。
 * 路径模式支持 :param 占位符；处理函数收到 ctx = { app, url, params, body() }。
 * 新增接口只需在表里加一行。
 */
const ROUTES = [
  ['GET', '/api/health', (ctx) => healthPayload(ctx.app)],

  // 脚本直接运行
  ['POST', '/api/scripts/run', async (ctx) => runScriptAndReadResult(ctx.app, await ctx.body())],

  // 任务
  ['GET', '/api/tasks', (ctx) => ctx.app.queryBus.execute(listTasksQuery())],
  ['POST', '/api/tasks', async (ctx) => {
    const result = await ctx.app.commandBus.execute(createTaskCommand(await ctx.body()));
    return { taskId: result.data.taskId };
  }],
  ['PATCH', '/api/tasks/batch/enabled', async (ctx) => {
    const body = await ctx.body();
    return batchExecute(body.ids, (taskId) =>
      ctx.app.commandBus.execute(setTaskEnabledCommand({ taskId, enabled: body.enabled })));
  }],
  ['PATCH', '/api/tasks/batch/pinned', async (ctx) => {
    const body = await ctx.body();
    return batchExecute(body.ids, (taskId) =>
      ctx.app.commandBus.execute(setTaskPinnedCommand({ taskId, pinned: body.pinned })));
  }],
  ['POST', '/api/tasks/batch/labels', async (ctx) =>
    ctx.app.commandBus.execute(updateTaskLabelsCommand(await ctx.body()))],
  ['POST', '/api/tasks/batch/run', async (ctx) => {
    const body = await ctx.body();
    return batchExecute(body.ids, (taskId) =>
      ctx.app.commandBus.execute(runTaskNowCommand({ taskId, trigger: body.trigger || 'api' })));
  }],
  ['POST', '/api/tasks/batch/stop', async (ctx) => {
    const body = await ctx.body();
    return batchExecute(body.ids, (taskId) =>
      ctx.app.commandBus.execute(stopTaskRunCommand({ taskId })));
  }],
  ['POST', '/api/tasks/:id/run', async (ctx) => {
    const body = await ctx.body();
    const result = await ctx.app.commandBus.execute(runTaskNowCommand({
      taskId: ctx.params.id,
      trigger: body.trigger || 'api'
    }));
    return readRunWithLog(ctx.app, result.data.runId);
  }],
  ['POST', '/api/tasks/:id/stop', async (ctx) =>
    (await ctx.app.commandBus.execute(stopTaskRunCommand({ taskId: ctx.params.id }))).data],
  ['PATCH', '/api/tasks/:id/enabled', async (ctx) => {
    const body = await ctx.body();
    return (await ctx.app.commandBus.execute(setTaskEnabledCommand({
      taskId: ctx.params.id,
      enabled: body.enabled
    }))).data;
  }],
  ['PATCH', '/api/tasks/:id/pinned', async (ctx) => {
    const body = await ctx.body();
    return (await ctx.app.commandBus.execute(setTaskPinnedCommand({
      taskId: ctx.params.id,
      pinned: body.pinned
    }))).data;
  }],
  ['PUT', '/api/tasks/:id', updateTaskRoute],
  ['PATCH', '/api/tasks/:id', updateTaskRoute],
  ['DELETE', '/api/tasks/:id', async (ctx) =>
    (await ctx.app.commandBus.execute(deleteTaskCommand({ taskId: ctx.params.id }))).data],

  // 运行记录
  ['GET', '/api/runs', (ctx) => ctx.app.queryBus.execute(listRunsQuery({
    limit: Number(ctx.url.searchParams.get('limit')) || 50
  }))],
  ['GET', '/api/runs/:id/log', (ctx) => ctx.app.queryBus.execute(getRunLogQuery({
    runId: ctx.params.id,
    stream: ctx.url.searchParams.get('stream') || 'combined'
  }))],
  ['GET', '/api/runs/:id', (ctx) => ctx.app.queryBus.execute(getRunQuery({ runId: ctx.params.id }))],

  // 设置 / 日志清理 / 开机启动
  ['GET', '/api/settings', (ctx) => ctx.app.repositories.settingsRepository.get()],
  ['POST', '/api/settings', async (ctx) => ctx.app.repositories.settingsRepository.save(await ctx.body())],
  ['POST', '/api/logs/cleanup', (ctx) => ctx.app.services.logCleanupService.cleanNow()],
  ['GET', '/api/startup', () => getStartupTaskStatus(process.execPath)],
  ['POST', '/api/startup/enable', () => enableStartupTask(process.execPath)],
  ['POST', '/api/startup/disable', () => disableStartupTask()]
];

// 青龙式接口，同时支持 /api/ql/xxx 与 /api/xxx 两种前缀（见 rewriteQinglongAlias）。
const QINGLONG_ROUTES = [
  ['GET', '/api/ql/overview', (ctx) => ctx.service.getOverview()],
  ['GET', '/api/ql/envs', (ctx) => ctx.service.listEnvs()],
  ['POST', '/api/ql/envs', async (ctx) => ctx.service.saveEnv(await ctx.body())],
  ['PATCH', '/api/ql/envs/status', async (ctx) => {
    const body = await ctx.body();
    return ctx.service.setEnvStatus(body.ids || [], body.status);
  }],
  ['DELETE', '/api/ql/envs', async (ctx) => ctx.service.deleteEnvs((await ctx.body()).ids || [])],
  ['GET', '/api/ql/configs', (ctx) => {
    const name = ctx.url.searchParams.get('name');
    return name ? ctx.service.getConfig(name) : ctx.service.listConfigs();
  }],
  ['GET', '/api/ql/configs/:name', (ctx) => ctx.service.getConfig(decodeURIComponent(ctx.params.name))],
  ['POST', '/api/ql/configs', async (ctx) => ctx.service.saveConfig(await ctx.body())],
  ['PUT', '/api/ql/configs', async (ctx) => ctx.service.saveConfig(await ctx.body())],
  ['GET', '/api/ql/scripts', (ctx) => {
    const scriptPath = ctx.url.searchParams.get('path');
    return scriptPath ? ctx.service.getScript(scriptPath) : ctx.service.listScripts();
  }],
  ['POST', '/api/ql/scripts/run', async (ctx) => {
    const body = await ctx.body();
    return runScriptAndReadResult(ctx.app, { ...body, scriptPath: body.scriptPath || body.path });
  }],
  ['POST', '/api/ql/scripts', async (ctx) => ctx.service.saveScript(await ctx.body())],
  ['PUT', '/api/ql/scripts', async (ctx) => ctx.service.saveScript(await ctx.body())],
  ['DELETE', '/api/ql/scripts', async (ctx) => ctx.service.deleteScripts((await ctx.body()).paths || [])],
  ['GET', '/api/ql/subscriptions', (ctx) => ctx.service.listSubscriptions()],
  ['POST', '/api/ql/subscriptions', async (ctx) => ctx.service.saveSubscription(await ctx.body())],
  ['DELETE', '/api/ql/subscriptions', async (ctx) => ctx.service.deleteSubscriptions((await ctx.body()).ids || [])],
  ['POST', '/api/ql/subscriptions/:id/run', (ctx) => ctx.service.runSubscription(decodeURIComponent(ctx.params.id), {
    background: ['1', 'true'].includes(String(ctx.url.searchParams.get('background') || '').toLowerCase()),
    waitForCompletion: String(ctx.url.searchParams.get('waitForCompletion') || '').toLowerCase() === 'false' ? false : undefined
  })],
  ['GET', '/api/ql/dependencies', (ctx) => ctx.service.listDependencies()],
  ['POST', '/api/ql/dependencies', async (ctx) => ctx.service.installDependency((await ctx.body()).name)],
  ['DELETE', '/api/ql/dependencies', async (ctx) => ctx.service.removeDependency((await ctx.body()).name)]
];

const COMPILED_ROUTES = [...ROUTES, ...QINGLONG_ROUTES].map(([method, pattern, handler]) => ({
  method,
  pattern,
  regex: compilePattern(pattern),
  handler
}));

export function startApiServer(coreApp, options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port || 18760;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url, `http://${host}:${port}`);
      const result = await dispatch(coreApp, request, url);
      writeJson(response, 200, { ok: true, data: result });
    } catch (error) {
      const appError = toAppError(error);
      writeJson(response, resolveErrorStatusCode(error, appError), { ok: false, error: appError.toPayload() });
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`本机 API 端口被占用: ${host}:${port}，接口未启动，界面功能不受影响`);
      return;
    }
    console.error('本机 API 服务异常:', error);
  });

  server.listen(port, host);
  return { host, port, server, url: `http://${host}:${port}` };
}

async function dispatch(app, request, url) {
  const pathname = rewriteQinglongAlias(url.pathname);
  for (const route of COMPILED_ROUTES) {
    if (route.method !== request.method) continue;
    const match = pathname.match(route.regex);
    if (!match) continue;
    return route.handler({
      app,
      service: app.services.qinglongService,
      url,
      params: match.groups || {},
      body: () => readJson(request)
    });
  }

  const notFound = new Error(`接口不存在: ${request.method} ${url.pathname}`);
  notFound.statusCode = 404;
  throw notFound;
}

// '/api/tasks/:id/run' -> /^\/api\/tasks\/(?<id>[^/]+)\/run$/
function compilePattern(pattern) {
  const source = pattern
    .split('/')
    .map((segment) => segment.startsWith(':')
      ? `(?<${segment.slice(1)}>[^/]+)`
      : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(`^${source}$`);
}

// 青龙接口的别名前缀：/api/envs 等同 /api/ql/envs。
function rewriteQinglongAlias(pathname) {
  const aliases = ['overview', 'envs', 'configs', 'scripts', 'subscriptions', 'dependencies'];
  const match = pathname.match(/^\/api\/([^/]+)(\/.*)?$/);
  if (match && aliases.includes(match[1])) {
    return `/api/ql/${match[1]}${match[2] || ''}`;
  }
  return pathname;
}

async function updateTaskRoute(ctx) {
  const body = await ctx.body();
  return (await ctx.app.commandBus.execute(updateTaskCommand({
    ...body,
    taskId: ctx.params.id
  }))).data;
}

function healthPayload(app) {
  return {
    status: '正常',
    api: 'ScriptPilot 本机接口',
    version: '0.1.0',
    language: 'zh-CN',
    auth: '未启用权限校验',
    listen: '仅监听 127.0.0.1',
    dataRoot: app.paths.dataRoot,
    endpoints: [...ROUTES, ...QINGLONG_ROUTES].map(([method, pattern]) => `${method} ${pattern}`)
  };
}

export async function runScriptAndReadResult(coreApp, input) {
  const commandResult = await coreApp.commandBus.execute(runScriptOnceCommand(input));
  if (input?.waitForCompletion === false) {
    return commandResult.data;
  }
  return readRunWithLog(coreApp, commandResult.data.runId);
}

async function readRunWithLog(coreApp, runId) {
  const run = await coreApp.queryBus.execute(getRunQuery({ runId }));
  const log = await coreApp.queryBus.execute(getRunLogQuery({ runId: run.id, stream: 'combined' }));
  return { run, log };
}

async function batchExecute(ids = [], fn) {
  const results = [];
  for (const id of ids) {
    const result = await fn(id);
    results.push(result.data || result);
  }
  return { ids, results };
}

function resolveErrorStatusCode(error, appError) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  const code = String(appError.code || '');
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code.startsWith('INVALID_') || code.endsWith('_REQUIRED') || code.endsWith('_EXISTS')) return 400;
  return 500;
}

async function readJson(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      const error = new Error('请求体过大，最大支持 5 MB');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload, null, 2));
}

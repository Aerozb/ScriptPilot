import http from 'node:http';
import { URL } from 'node:url';
import { createTaskCommand } from '../main/modules/tasks/application/commands/create-task.command.js';
import { updateTaskCommand } from '../main/modules/tasks/application/commands/update-task.command.js';
import { deleteTaskCommand } from '../main/modules/tasks/application/commands/delete-task.command.js';
import { setTaskEnabledCommand } from '../main/modules/tasks/application/commands/set-task-enabled.command.js';
import { setTasksEnabledCommand } from '../main/modules/tasks/application/commands/set-tasks-enabled.command.js';
import { setTaskPinnedCommand } from '../main/modules/tasks/application/commands/set-task-pinned.command.js';
import { setTasksPinnedCommand } from '../main/modules/tasks/application/commands/set-tasks-pinned.command.js';
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

export function startApiServer(coreApp, options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port || 18760;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        writeNoContent(response);
        return;
      }

      const url = new URL(request.url, `http://${host}:${port}`);
      const result = await routeRequest(coreApp, request, url);
      writeJson(response, 200, { ok: true, data: result });
    } catch (error) {
      const appError = toAppError(error);
      writeJson(response, error.statusCode || 500, { ok: false, error: appError.toPayload() });
    }
  });

  server.listen(port, host);
  return {
    host,
    port,
    server,
    url: `http://${host}:${port}`
  };
}

async function routeRequest(coreApp, request, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return {
      status: '正常',
      api: 'ScriptPilot 本机接口',
      version: '0.1.0',
      language: 'zh-CN',
      auth: '未启用权限校验',
      listen: '仅监听 127.0.0.1',
      dataRoot: coreApp.paths.dataRoot,
      endpoints: [
        'POST /api/scripts/run',
        'GET /api/tasks',
        'POST /api/tasks',
        'POST /api/tasks/:id/run',
        'PATCH /api/tasks/:id/enabled',
        'DELETE /api/tasks/:id',
        'GET /api/runs',
        'GET /api/runs/:id',
        'GET /api/runs/:id/log',
        'POST /api/logs/cleanup',
        'GET /api/ql/overview',
        'GET /api/ql/envs',
        'POST /api/ql/envs',
        'PATCH /api/ql/envs/status',
        'DELETE /api/ql/envs',
        'GET /api/ql/configs',
        'GET /api/ql/scripts',
        'POST /api/ql/scripts',
        'POST /api/ql/scripts/run',
        'GET /api/ql/subscriptions',
        'POST /api/ql/subscriptions',
        'POST /api/ql/subscriptions/:id/run',
        'GET /api/ql/dependencies',
        'POST /api/ql/dependencies',
        'DELETE /api/ql/dependencies',
        'GET /api/startup',
        'POST /api/startup/enable',
        'POST /api/startup/disable'
      ]
    };
  }

  if (request.method === 'POST' && url.pathname === '/api/scripts/run') {
    return runScriptAndReadResult(coreApp, await readJson(request));
  }

  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    return coreApp.queryBus.execute(listTasksQuery());
  }

  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const commandResult = await coreApp.commandBus.execute(createTaskCommand(await readJson(request)));
    return {
      taskId: commandResult.data.taskId
    };
  }

  if (request.method === 'PATCH' && url.pathname === '/api/tasks/batch/enabled') {
    const body = await readJson(request);
    const commandResult = await coreApp.commandBus.execute(setTasksEnabledCommand({
      ids: body.ids || [],
      enabled: body.enabled
    }));
    return commandResult.data;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/tasks/batch/pinned') {
    const body = await readJson(request);
    const commandResult = await coreApp.commandBus.execute(setTasksPinnedCommand({
      ids: body.ids || [],
      pinned: body.pinned
    }));
    return commandResult.data;
  }

  if (request.method === 'POST' && url.pathname === '/api/tasks/batch/labels') {
    return coreApp.commandBus.execute(updateTaskLabelsCommand(await readJson(request)));
  }

  if (request.method === 'POST' && url.pathname === '/api/tasks/batch/run') {
    const body = await readJson(request);
    return batchExecute(body.ids || [], async (taskId) => coreApp.commandBus.execute(runTaskNowCommand({
      taskId,
      trigger: body.trigger || 'api'
    })));
  }

  if (request.method === 'POST' && url.pathname === '/api/tasks/batch/stop') {
    const body = await readJson(request);
    return batchExecute(body.ids || [], async (taskId) => coreApp.commandBus.execute(stopTaskRunCommand({ taskId })));
  }

  const taskRunMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (request.method === 'POST' && taskRunMatch) {
    const body = await readJson(request);
    const commandResult = await coreApp.commandBus.execute(runTaskNowCommand({
      taskId: taskRunMatch[1],
      trigger: body.trigger || 'api'
    }));
    const run = await coreApp.queryBus.execute(getRunQuery({ runId: commandResult.data.runId }));
    const log = await coreApp.queryBus.execute(getRunLogQuery({ runId: run.id, stream: 'combined' }));
    return { run, log };
  }

  const taskStopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
  if (request.method === 'POST' && taskStopMatch) {
    const commandResult = await coreApp.commandBus.execute(stopTaskRunCommand({ taskId: taskStopMatch[1] }));
    return commandResult.data;
  }

  const taskEnabledMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/enabled$/);
  if (request.method === 'PATCH' && taskEnabledMatch) {
    const body = await readJson(request);
    const commandResult = await coreApp.commandBus.execute(setTaskEnabledCommand({
      taskId: taskEnabledMatch[1],
      enabled: body.enabled
    }));
    return commandResult.data;
  }

  const taskPinnedMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pinned$/);
  if (request.method === 'PATCH' && taskPinnedMatch) {
    const body = await readJson(request);
    const commandResult = await coreApp.commandBus.execute(setTaskPinnedCommand({
      taskId: taskPinnedMatch[1],
      pinned: body.pinned
    }));
    return commandResult.data;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if ((request.method === 'PUT' || request.method === 'PATCH') && taskMatch) {
    const body = await readJson(request);
    const commandResult = await coreApp.commandBus.execute(updateTaskCommand({
      ...body,
      taskId: taskMatch[1]
    }));
    return commandResult.data;
  }

  if (request.method === 'DELETE' && taskMatch) {
    const commandResult = await coreApp.commandBus.execute(deleteTaskCommand({ taskId: taskMatch[1] }));
    return commandResult.data;
  }

  if (request.method === 'GET' && url.pathname === '/api/runs') {
    return coreApp.queryBus.execute(listRunsQuery({
      limit: Number(url.searchParams.get('limit')) || 50
    }));
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(\/log)?$/);
  if (request.method === 'GET' && runMatch) {
    const runId = runMatch[1];
    if (runMatch[2]) {
      return coreApp.queryBus.execute(getRunLogQuery({
        runId,
        stream: url.searchParams.get('stream') || 'combined'
      }));
    }
    return coreApp.queryBus.execute(getRunQuery({ runId }));
  }

  if (request.method === 'GET' && url.pathname === '/api/settings') {
    return coreApp.repositories.settingsRepository.get();
  }

  if (request.method === 'POST' && url.pathname === '/api/settings') {
    return coreApp.repositories.settingsRepository.save(await readJson(request));
  }

  if (request.method === 'POST' && url.pathname === '/api/logs/cleanup') {
    return coreApp.services.logCleanupService.cleanNow();
  }

  if (request.method === 'GET' && url.pathname === '/api/startup') {
    return getStartupTaskStatus(process.execPath);
  }

  if (request.method === 'POST' && url.pathname === '/api/startup/enable') {
    return enableStartupTask(process.execPath);
  }

  if (request.method === 'POST' && url.pathname === '/api/startup/disable') {
    return disableStartupTask();
  }

  const qlResult = await routeQinglongRequest(coreApp, request, url);
  if (qlResult.handled) return qlResult.data;

  const notFound = new Error(`接口不存在: ${request.method} ${url.pathname}`);
  notFound.statusCode = 404;
  throw notFound;
}

async function routeQinglongRequest(coreApp, request, url) {
  const service = coreApp.services.qinglongService;
  const pathname = normalizeQinglongPath(url.pathname);

  if (request.method === 'GET' && pathname === '/overview') {
    return handled(await service.getOverview());
  }

  if (request.method === 'GET' && pathname === '/envs') {
    return handled(await service.listEnvs());
  }

  if (request.method === 'POST' && pathname === '/envs') {
    return handled(await service.saveEnv(await readJson(request)));
  }

  if (request.method === 'PATCH' && pathname === '/envs/status') {
    const body = await readJson(request);
    return handled(await service.setEnvStatus(body.ids || [], body.status));
  }

  if (request.method === 'DELETE' && pathname === '/envs') {
    const body = await readJson(request);
    return handled(await service.deleteEnvs(body.ids || []));
  }

  if (request.method === 'GET' && pathname === '/configs') {
    const name = url.searchParams.get('name');
    return handled(name ? await service.getConfig(name) : await service.listConfigs());
  }

  const configMatch = pathname.match(/^\/configs\/(.+)$/);
  if (request.method === 'GET' && configMatch) {
    return handled(await service.getConfig(decodeURIComponent(configMatch[1])));
  }

  if ((request.method === 'POST' || request.method === 'PUT') && pathname === '/configs') {
    return handled(await service.saveConfig(await readJson(request)));
  }

  if (request.method === 'GET' && pathname === '/scripts') {
    const scriptPath = url.searchParams.get('path');
    return handled(scriptPath ? await service.getScript(scriptPath) : await service.listScripts());
  }

  if ((request.method === 'POST' || request.method === 'PUT') && pathname === '/scripts') {
    return handled(await service.saveScript(await readJson(request)));
  }

  if (request.method === 'DELETE' && pathname === '/scripts') {
    const body = await readJson(request);
    return handled(await service.deleteScripts(body.paths || []));
  }

  if (request.method === 'POST' && pathname === '/scripts/run') {
    const body = await readJson(request);
    return handled(await runScriptAndReadResult(coreApp, {
      ...body,
      scriptPath: body.scriptPath || body.path
    }));
  }

  if (request.method === 'GET' && pathname === '/subscriptions') {
    return handled(await service.listSubscriptions());
  }

  if (request.method === 'POST' && pathname === '/subscriptions') {
    return handled(await service.saveSubscription(await readJson(request)));
  }

  if (request.method === 'DELETE' && pathname === '/subscriptions') {
    const body = await readJson(request);
    return handled(await service.deleteSubscriptions(body.ids || []));
  }

  const subscriptionRunMatch = pathname.match(/^\/subscriptions\/([^/]+)\/run$/);
  if (request.method === 'POST' && subscriptionRunMatch) {
    return handled(await service.runSubscription(decodeURIComponent(subscriptionRunMatch[1]), {
      background: ['1', 'true'].includes(String(url.searchParams.get('background') || '').toLowerCase()),
      waitForCompletion: String(url.searchParams.get('waitForCompletion') || '').toLowerCase() === 'false' ? false : undefined
    }));
  }

  if (request.method === 'GET' && pathname === '/dependencies') {
    return handled(await service.listDependencies());
  }

  if (request.method === 'POST' && pathname === '/dependencies') {
    const body = await readJson(request);
    return handled(await service.installDependency(body.name));
  }

  if (request.method === 'DELETE' && pathname === '/dependencies') {
    const body = await readJson(request);
    return handled(await service.removeDependency(body.name));
  }

  return { handled: false };
}

async function runScriptAndReadResult(coreApp, input) {
  const commandResult = await coreApp.commandBus.execute(runScriptOnceCommand(input));
  if (input?.waitForCompletion === false) {
    return commandResult.data;
  }
  const run = await coreApp.queryBus.execute(getRunQuery({ runId: commandResult.data.runId }));
  const log = await coreApp.queryBus.execute(getRunLogQuery({ runId: run.id, stream: 'combined' }));
  return { run, log };
}

function normalizeQinglongPath(pathname) {
  if (pathname.startsWith('/api/ql')) return pathname.slice('/api/ql'.length) || '/';
  const aliases = ['/overview', '/envs', '/configs', '/scripts', '/subscriptions', '/dependencies'];
  for (const alias of aliases) {
    if (pathname === `/api${alias}` || pathname.startsWith(`/api${alias}/`)) {
      return pathname.slice('/api'.length);
    }
  }
  return '';
}

function handled(data) {
  return { handled: true, data };
}

async function batchExecute(ids, fn) {
  const results = [];
  for (const id of ids) {
    const result = await fn(id);
    results.push(result.data || result);
  }
  return { ids, results };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
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
    ...corsHeaders(),
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeNoContent(response) {
  response.writeHead(204, corsHeaders());
  response.end();
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

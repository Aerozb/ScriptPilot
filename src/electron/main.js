import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createApp } from '../main/app/create-app.js';
import { ensureDemoTaskAndRun } from '../main/app/demo-runner.js';
import { startApiServer, runScriptAndReadResult } from './api-server.js';
import { createTaskCommand } from '../main/modules/tasks/application/commands/create-task.command.js';
import { updateTaskCommand } from '../main/modules/tasks/application/commands/update-task.command.js';
import { deleteTaskCommand } from '../main/modules/tasks/application/commands/delete-task.command.js';
import { setTaskEnabledCommand } from '../main/modules/tasks/application/commands/set-task-enabled.command.js';
import { setTaskPinnedCommand } from '../main/modules/tasks/application/commands/set-task-pinned.command.js';
import { updateTaskLabelsCommand } from '../main/modules/tasks/application/commands/update-task-labels.command.js';
import { listTasksQuery } from '../main/modules/tasks/application/queries/list-tasks.query.js';
import { runTaskNowCommand } from '../main/modules/runs/application/commands/run-task-now.command.js';
import { stopTaskRunCommand } from '../main/modules/runs/application/commands/stop-task-run.command.js';
import { listRunsQuery } from '../main/modules/runs/application/queries/list-runs.query.js';
import { getRunQuery } from '../main/modules/runs/application/queries/get-run.query.js';
import { getRunLogQuery } from '../main/modules/runs/application/queries/get-run-log.query.js';
import { disableStartupTask, enableStartupTask, getStartupTaskStatus } from '../main/modules/startup/infrastructure/windows-startup-task.js';
import { AppError, toAppError } from '../main/shared/errors/app-error.js';
import { assertInsidePath, resolvePortablePath } from '../main/bootstrap/portable-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appIconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
let coreApp;
let mainWindow;
let apiServer;
let startsInBackground = false;

function getPortableRoot() {
  if (app.isPackaged) return path.dirname(process.execPath);
  // 开发模式支持用环境变量隔离数据目录（测试基线要求）。
  return process.env.SCRIPTPILOT_PORTABLE_ROOT
    ? path.resolve(process.env.SCRIPTPILOT_PORTABLE_ROOT)
    : process.cwd();
}

function setupPortableElectronPaths(portableRoot) {
  const dataRoot = path.join(portableRoot, 'data');
  app.setPath('userData', path.join(dataRoot, 'electron-user-data'));
  app.setPath('sessionData', path.join(dataRoot, 'session'));
  app.setPath('logs', path.join(dataRoot, 'logs', 'app'));
  app.setPath('crashDumps', path.join(dataRoot, 'crash-dumps'));
  app.setPath('temp', path.join(dataRoot, 'tmp'));
  app.setAppLogsPath(path.join(dataRoot, 'logs', 'app'));
}

async function createMainWindow(options = {}) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: options.show !== false,
    title: 'ScriptPilot',
    icon: appIconPath,
    backgroundColor: '#e8edf4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow({ show: true }).catch((error) => console.error(error));
    return;
  }

  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// 声明式 IPC 通道表：新增能力只需加一行。input 为渲染进程传入的参数。
function createIpcChannels() {
  const ql = () => coreApp.services.qinglongService;
  return {
    'task:list': () => coreApp.queryBus.execute(listTasksQuery()),
    'task:create': (input) => coreApp.commandBus.execute(createTaskCommand(input)),
    'task:update': (input) => coreApp.commandBus.execute(updateTaskCommand(input)),
    'task:set-enabled': (input) => coreApp.commandBus.execute(setTaskEnabledCommand(input)),
    'task:set-pinned': (input) => coreApp.commandBus.execute(setTaskPinnedCommand(input)),
    'task:update-labels': (input) => coreApp.commandBus.execute(updateTaskLabelsCommand(input)),
    'task:delete': (input) => coreApp.commandBus.execute(deleteTaskCommand(input)),
    'task:run-now': (input) => coreApp.commandBus.execute(runTaskNowCommand(input)),
    'task:stop-run': (input) => coreApp.commandBus.execute(stopTaskRunCommand(input)),
    'script:run-once': (input) => runScriptAndReadResult(coreApp, input),
    'run:list': (input) => coreApp.queryBus.execute(listRunsQuery(input || {})),
    'run:get': (input) => coreApp.queryBus.execute(getRunQuery(input)),
    'run:get-log': (input) => coreApp.queryBus.execute(getRunLogQuery(input)),
    'app:get-info': () => ({
      portableRoot: coreApp.paths.portableRoot,
      dataRoot: coreApp.paths.dataRoot,
      runtimeRoot: coreApp.paths.runtimeRoot,
      apiUrl: apiServer?.url,
      menuLabels: Menu.getApplicationMenu()?.items.map((item) => item.label) || []
    }),
    'app:open-data-dir': () => shell.openPath(coreApp.paths.dataRoot),
    'app:open-portable-path': (input) => openPortablePath(input),
    'demo:run': () => ensureDemoTaskAndRun(coreApp, 'scriptpilot-ui'),
    'startup:status': () => getStartupTaskStatus(process.execPath),
    'startup:enable': () => enableStartupTask(process.execPath),
    'startup:disable': () => disableStartupTask(),
    'settings:get': () => coreApp.repositories.settingsRepository.get(),
    'settings:save': (input) => coreApp.repositories.settingsRepository.save(input),
    'logs:cleanup-now': () => coreApp.services.logCleanupService.cleanNow(),
    'ql:overview': () => ql().getOverview(),
    'ql:env:list': () => ql().listEnvs(),
    'ql:env:save': (input) => ql().saveEnv(input),
    'ql:env:delete': (input) => ql().deleteEnvs(input?.ids || []),
    'ql:env:set-status': (input) => ql().setEnvStatus(input?.ids || [], input?.status),
    'ql:config:list': () => ql().listConfigs(),
    'ql:config:get': (input) => ql().getConfig(input?.name),
    'ql:config:save': (input) => ql().saveConfig(input),
    'ql:script:list': () => ql().listScripts(),
    'ql:script:get': (input) => ql().getScript(input?.path),
    'ql:script:save': (input) => ql().saveScript(input),
    'ql:script:delete': (input) => ql().deleteScripts(input?.paths || []),
    'ql:subscription:list': () => ql().listSubscriptions(),
    'ql:subscription:save': (input) => ql().saveSubscription(input),
    'ql:subscription:delete': (input) => ql().deleteSubscriptions(input?.ids || []),
    'ql:subscription:run': (input) => ql().runSubscription(input?.id, input || {}),
    'ql:dependency:list': () => ql().listDependencies(),
    'ql:dependency:install': (input) => ql().installDependency(input?.name),
    'ql:dependency:remove': (input) => ql().removeDependency(input?.name)
  };
}

function registerIpc() {
  for (const [channel, handler] of Object.entries(createIpcChannels())) {
    ipcMain.handle(channel, (_event, input) => safeInvoke(() => handler(input)));
  }
}

async function openPortablePath(input = {}) {
  const absolutePath = resolvePortablePath(coreApp.paths, input.path || 'data', { label: '打开路径' });
  const requestedPath = input.kind === 'file' ? path.dirname(absolutePath) : absolutePath;
  const targetPath = await findExistingPortableAncestor(requestedPath);
  assertInsidePath(coreApp.paths.portableRoot, targetPath, '打开路径');
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    throw new AppError('OPEN_PATH_FAILED', `打开目录失败: ${errorMessage}`, { path: targetPath });
  }
  return { path: targetPath };
}

async function findExistingPortableAncestor(inputPath) {
  let current = path.resolve(inputPath);
  const root = path.resolve(coreApp.paths.portableRoot);

  while (true) {
    assertInsidePath(root, current, '打开路径');
    try {
      const currentStat = await stat(current);
      if (currentStat.isDirectory()) return current;
      return path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return root;
      current = parent;
    }
  }
}

async function safeInvoke(fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toAppError(error).toPayload() };
  }
}

const portableRoot = getPortableRoot();
setupPortableElectronPaths(portableRoot);

const shouldRunSmokeDemo =
  process.env.SCRIPTPILOT_SMOKE_RUN_DEMO === '1' ||
  app.commandLine.hasSwitch('smoke-run-demo') ||
  process.argv.includes('--smoke-run-demo');

if (shouldRunSmokeDemo) {
  app.whenReady().then(() => runSmokeDemoAndExit(portableRoot));
} else {
  const shouldBypassSingleInstanceLock =
    app.commandLine.hasSwitch('acceptance-test') ||
    app.commandLine.hasSwitch('ui-flow-test') ||
    app.commandLine.hasSwitch('ui-smoke') ||
    process.argv.includes('--acceptance-test') ||
    process.argv.includes('--ui-flow-test') ||
    process.argv.includes('--ui-smoke');
  const gotLock = shouldBypassSingleInstanceLock || app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      showMainWindow();
    });

    app.whenReady().then(async () => {
      coreApp = await createApp({ portableRoot });
      apiServer = startApiServer(coreApp, {
        port: readApiPort()
      });
      coreApp.scheduler.start();
      coreApp.services.logCleanupService.start();
      registerIpc();
      // 不使用应用菜单栏，界面操作都在页面内完成。
      Menu.setApplicationMenu(null);
      startsInBackground = app.commandLine.hasSwitch('background') || process.argv.includes('--background');
      await createMainWindow({ show: !startsInBackground });
    });

    app.on('before-quit', () => {
      coreApp?.scheduler?.stop();
      coreApp?.services?.logCleanupService?.stop();
      apiServer?.server?.close();
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  }
}

function readApiPort() {
  const value = Number(process.env.SCRIPTPILOT_API_PORT);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 18760;
}

async function runSmokeDemoAndExit(portableRoot) {
  const resultPath = path.join(portableRoot, 'data', 'state', 'smoke-result.json');
  try {
    const smokeApp = await createApp({ portableRoot });
    const result = await ensureDemoTaskAndRun(smokeApp, 'scriptpilot-exe-smoke');
    await writeSmokeResult(resultPath, {
      ok: result.run.status === 'success',
      summary: result.summary,
      logText: result.log.text
    });
    console.log(JSON.stringify(result.summary, null, 2));
    console.log('--- combined log ---');
    console.log(result.log.text.trimEnd());
    app.exit(result.run.status === 'success' ? 0 : 1);
  } catch (error) {
    const payload = toAppError(error).toPayload();
    await writeSmokeResult(resultPath, {
      ok: false,
      error: payload
    });
    console.error(JSON.stringify(payload, null, 2));
    app.exit(1);
  }
}

async function writeSmokeResult(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    ...payload,
    writtenAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

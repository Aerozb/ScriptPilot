import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createApp } from '../main/app/create-app.js';
import { ensureDemoTaskAndRun } from '../main/app/demo-runner.js';
import { startApiServer } from './api-server.js';
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
import { runScriptOnceCommand } from '../main/modules/runs/application/commands/run-script-once.command.js';
import { disableStartupTask, enableStartupTask, getStartupTaskStatus } from '../main/modules/startup/infrastructure/windows-startup-task.js';
import { AppError, toAppError } from '../main/shared/errors/app-error.js';
import { assertInsidePath, resolvePortablePath } from '../main/bootstrap/portable-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let coreApp;
let mainWindow;
let apiServer;
let startsInBackground = false;

function getPortableRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : process.cwd();
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
    backgroundColor: '#e8edf4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function setupChineseMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => coreApp && shell.openPath(coreApp.paths.dataRoot) },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '切换开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        { label: '关闭窗口', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 ScriptPilot', click: () => showMainWindow() }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

function registerIpc() {
  ipcMain.handle('task:list', async () => safeInvoke(() => coreApp.queryBus.execute(listTasksQuery())));
  ipcMain.handle('task:create', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(createTaskCommand(input))));
  ipcMain.handle('task:update', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(updateTaskCommand(input))));
  ipcMain.handle('task:set-enabled', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(setTaskEnabledCommand(input))));
  ipcMain.handle('task:set-pinned', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(setTaskPinnedCommand(input))));
  ipcMain.handle('task:update-labels', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(updateTaskLabelsCommand(input))));
  ipcMain.handle('task:delete', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(deleteTaskCommand(input))));
  ipcMain.handle('task:run-now', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(runTaskNowCommand(input))));
  ipcMain.handle('task:stop-run', async (_event, input) => safeInvoke(() => coreApp.commandBus.execute(stopTaskRunCommand(input))));
  ipcMain.handle('script:run-once', async (_event, input) => safeInvoke(() => runScriptAndReadResult(input)));
  ipcMain.handle('run:list', async (_event, input) => safeInvoke(() => coreApp.queryBus.execute(listRunsQuery(input || {}))));
  ipcMain.handle('run:get', async (_event, input) => safeInvoke(() => coreApp.queryBus.execute(getRunQuery(input))));
  ipcMain.handle('run:get-log', async (_event, input) => safeInvoke(() => coreApp.queryBus.execute(getRunLogQuery(input))));
  ipcMain.handle('app:get-info', async () => safeInvoke(async () => ({
    portableRoot: coreApp.paths.portableRoot,
    dataRoot: coreApp.paths.dataRoot,
    runtimeRoot: coreApp.paths.runtimeRoot,
    apiUrl: apiServer?.url,
    menuLabels: Menu.getApplicationMenu()?.items.map((item) => item.label) || []
  })));
  ipcMain.handle('app:open-data-dir', async () => safeInvoke(() => shell.openPath(coreApp.paths.dataRoot)));
  ipcMain.handle('app:open-portable-path', async (_event, input) => safeInvoke(() => openPortablePath(input)));
  ipcMain.handle('demo:run', async () => safeInvoke(() => ensureDemoTaskAndRun(coreApp, 'scriptpilot-ui')));
  ipcMain.handle('startup:status', async () => safeInvoke(() => getStartupTaskStatus(process.execPath)));
  ipcMain.handle('startup:enable', async () => safeInvoke(() => enableStartupTask(process.execPath)));
  ipcMain.handle('startup:disable', async () => safeInvoke(() => disableStartupTask()));
  ipcMain.handle('settings:get', async () => safeInvoke(() => coreApp.repositories.settingsRepository.get()));
  ipcMain.handle('settings:save', async (_event, input) => safeInvoke(() => coreApp.repositories.settingsRepository.save(input)));
  ipcMain.handle('logs:cleanup-now', async () => safeInvoke(() => coreApp.services.logCleanupService.cleanNow()));
  ipcMain.handle('ql:overview', async () => safeInvoke(() => coreApp.services.qinglongService.getOverview()));
  ipcMain.handle('ql:env:list', async () => safeInvoke(() => coreApp.services.qinglongService.listEnvs()));
  ipcMain.handle('ql:env:save', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.saveEnv(input)));
  ipcMain.handle('ql:env:delete', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.deleteEnvs(input?.ids || [])));
  ipcMain.handle('ql:env:set-status', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.setEnvStatus(input?.ids || [], input?.status)));
  ipcMain.handle('ql:config:list', async () => safeInvoke(() => coreApp.services.qinglongService.listConfigs()));
  ipcMain.handle('ql:config:get', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.getConfig(input?.name)));
  ipcMain.handle('ql:config:save', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.saveConfig(input)));
  ipcMain.handle('ql:script:list', async () => safeInvoke(() => coreApp.services.qinglongService.listScripts()));
  ipcMain.handle('ql:script:get', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.getScript(input?.path)));
  ipcMain.handle('ql:script:save', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.saveScript(input)));
  ipcMain.handle('ql:script:delete', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.deleteScripts(input?.paths || [])));
  ipcMain.handle('ql:subscription:list', async () => safeInvoke(() => coreApp.services.qinglongService.listSubscriptions()));
  ipcMain.handle('ql:subscription:save', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.saveSubscription(input)));
  ipcMain.handle('ql:subscription:delete', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.deleteSubscriptions(input?.ids || [])));
  ipcMain.handle('ql:subscription:run', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.runSubscription(input?.id)));
  ipcMain.handle('ql:dependency:list', async () => safeInvoke(() => coreApp.services.qinglongService.listDependencies()));
  ipcMain.handle('ql:dependency:install', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.installDependency(input?.name)));
  ipcMain.handle('ql:dependency:remove', async (_event, input) => safeInvoke(() => coreApp.services.qinglongService.removeDependency(input?.name)));
}

async function runScriptAndReadResult(input) {
  const commandResult = await coreApp.commandBus.execute(runScriptOnceCommand(input));
  if (input?.waitForCompletion === false) {
    return commandResult.data;
  }
  const run = await coreApp.queryBus.execute(getRunQuery({ runId: commandResult.data.runId }));
  const log = await coreApp.queryBus.execute(getRunLogQuery({ runId: run.id, stream: 'combined' }));
  return { run, log };
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
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      showMainWindow();
    });

  app.whenReady().then(async () => {
    coreApp = await createApp({ portableRoot });
    apiServer = startApiServer(coreApp);
    coreApp.scheduler.start();
    coreApp.services.logCleanupService.start();
    registerIpc();
    setupChineseMenu();
    startsInBackground = app.commandLine.hasSwitch('background') || process.argv.includes('--background');
    await createMainWindow({ show: !startsInBackground });
  });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  }
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

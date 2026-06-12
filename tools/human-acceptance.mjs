import { _electron as electron } from 'playwright';
import { rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root = process.cwd();
const releaseRoot = path.join(root, 'release', 'win-unpacked');
const launcherPath = path.join(releaseRoot, 'ScriptPilot.exe');
const appRoot = path.join(releaseRoot, 'app');
const exePath = path.join(appRoot, 'ScriptPilot.exe');
const dataRoot = path.join(appRoot, 'data');
const reportPath = path.join(dataRoot, 'state', 'human-acceptance-report.json');
const outsideRoot = path.join(path.dirname(releaseRoot), 'outside-portable-root-test');

const checks = [];

await assertPortableRootLayout();
await rm(dataRoot, { recursive: true, force: true });
await mkdir(path.dirname(reportPath), { recursive: true });

let app;
let dialogHandlerAttached = false;
const subscriptionFixture = await startSubscriptionFixtureServer();

try {
  console.log('启动 ScriptPilot EXE...');
  app = await electron.launch({
    executablePath: exePath,
    cwd: releaseRoot,
    args: ['--acceptance-test']
  });
  console.log('等待主窗口...');
  const page = await waitForMainWindow(app);
  page.setDefaultTimeout(90000);
  console.log('等待首屏渲染...');
  await page.waitForSelector('#pageTitle');
  await attachDialogHandler(page);

  await check('首次打开直接进入定时任务页面', async () => {
    await expectText(page, '#pageTitle', '定时任务');
    await page.locator('#taskTable').waitFor();
    const menuText = await page.locator('.menu').textContent();
    assert(menuText.includes('定时任务'), '菜单缺少定时任务');
    assert(menuText.includes('环境变量'), '菜单缺少环境变量');
    assert(!menuText.includes('登录') && !menuText.includes('账号'), '菜单不应包含登录或账号入口');
  });

  await check('系统设置显示绿色目录、API 和中文菜单', async () => {
    await page.locator('[data-page="setting"]').click();
    await expectText(page, '#pageTitle', '系统设置');
    await expectText(page, '#apiUrl', 'http://127.0.0.1:18760');
    await expectText(page, '#dataRoot', 'release');
    const dataReadme = await readFile(path.join(dataRoot, 'README.md'), 'utf8');
    assert(dataReadme.includes('ScriptPilot data 目录说明'), 'data/README.md 缺少标题说明');
    assert(dataReadme.includes('configs/') && dataReadme.includes('scripts/') && dataReadme.includes('repo/') && dataReadme.includes('raw/') && dataReadme.includes('state/'), 'data/README.md 缺少关键目录用途');
    const labels = await page.evaluate(() => window.scriptPilot.getInfo().then((info) => info.menuLabels));
    for (const label of ['文件', '编辑', '视图', '窗口', '帮助']) {
      assert(labels.includes(label), `应用菜单缺少中文项: ${label}`);
    }
  });

  await check('日志清理默认启用并支持实时保存配置', async () => {
    await page.locator('[data-page="setting"]').click();
    await expectText(page, '#logCleanupStatus', '上次清理');
    const statusText = await page.locator('#logCleanupStatus').textContent();
    assert(!statusText.includes('每 3 天检查一次') && !statusText.includes('超过 30 天'), '日志清理状态不应显示配置详情');
    assert(await page.locator('#saveLogCleanupButton').count() === 0, '日志清理不应再显示保存按钮');
    assert(await page.locator('#logCleanupEnabledInput').isChecked(), '日志清理默认没有启用');
    assert(await page.locator('#logRetentionDaysInput').inputValue() === '30', '日志保留天数默认不是 30');
    assert(await page.locator('#logCleanupIntervalDaysInput').inputValue() === '3', '日志清理周期默认不是 3');

    await page.locator('#logRetentionDaysInput').fill('7');
    await page.locator('#logCleanupIntervalDaysInput').fill('4');
    await waitForSettingsValue((settings) => (
      settings.logCleanup?.retentionDays === 7 &&
      settings.logCleanup?.intervalDays === 4 &&
      settings.logCleanup?.enabled === true
    ));

    await page.locator('#logRetentionDaysInput').fill('30');
    await page.locator('#logCleanupIntervalDaysInput').fill('3');
    await waitForSettingsValue((settings) => (
      settings.logCleanup?.retentionDays === 30 &&
      settings.logCleanup?.intervalDays === 3 &&
      settings.logCleanup?.enabled === true
    ));
  });

  await check('环境变量支持新建、批量禁用、批量启用', async () => {
    await page.locator('[data-page="env"]').click();
    await page.locator('#newEnvButton').click();
    await page.locator('#envNameInput').fill(`SP_TEST_ENV_${Date.now()}`);
    await page.locator('#envValueInput').fill('测试变量值');
    await page.locator('#envRemarksInput').fill('验收创建');
    await page.locator('#envForm button[type="submit"]').click();
    await expectText(page, '#envTable', 'SP_TEST_ENV');
    await page.locator('#envTable tbody tr').filter({ hasText: 'SP_TEST_ENV' }).locator('[data-env-check]').check();
    await page.locator('#batchDisableEnvsButton').click();
    await expectText(page, '#envTable', '禁用');
    await page.locator('#batchEnableEnvsButton').click();
    await expectText(page, '#envTable', '启用');
    const envs = JSON.parse(await readFile(path.join(dataRoot, 'state', 'envs.json'), 'utf8'));
    assert(envs.some((item) => item.name.startsWith('SP_TEST_ENV_')), '环境变量没有写入 data/state/envs.json');
  });

  await check('脚本管理支持保存脚本并运行查看日志', async () => {
    await openPage(page, 'script', '脚本管理');
    await clickActiveScriptControl(page, '#newScriptButton');
    const scriptPath = `data/scripts/acceptance-${Date.now()}.js`;
    const scriptFilePath = path.join(appRoot, scriptPath);
    await page.locator('#script.page.active #scriptPathInput').fill(scriptPath);
    await page.locator('#script.page.active #scriptEditor').fill([
      'const params = JSON.parse(process.env.SCRIPTPILOT_PARAMS || "{}");',
      'console.log("脚本管理运行成功");',
      'console.log(JSON.stringify({ params, argv: process.argv.slice(2) }));'
    ].join('\n'));
    await clickActiveScriptControl(page, '#saveScriptButton');
    await waitForFileContent(scriptFilePath, '脚本管理运行成功');
    await waitForScriptVisible(page, scriptPath);
    await page.locator(`#script.page.active [data-script-check="${scriptPath}"]`).check();
    await expectText(page, '#scriptSelectionText', '1 项');
    await clickActiveScriptControl(page, '#clearScriptSelectionButton');
    await expectText(page, '#scriptSelectionText', '0 项');
    await clickActiveScriptControl(page, '#deleteScriptButton');
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await expectText(page, '#confirmTitle', '删除脚本');
    await page.locator('#confirmCancelButton').click();
    await clickActiveScriptControl(page, '#runScriptFileButton');
    await expectText(page, '#pageTitle', '日志管理');
    await expectText(page, '#logViewer', '脚本管理运行成功');
  });

  await check('脚本管理支持全选后批量删除', async () => {
    await openPage(page, 'script', '脚本管理');
    const deleteScriptA = `data/scripts/delete-all-${Date.now()}-a.js`;
    const deleteScriptB = `data/scripts/delete-all-${Date.now()}-b.js`;
    await clickActiveScriptControl(page, '#newScriptButton');
    await page.locator('#script.page.active #scriptPathInput').fill(deleteScriptA);
    await page.locator('#script.page.active #scriptEditor').fill('console.log("delete all a");');
    await clickActiveScriptControl(page, '#saveScriptButton');
    await waitForFileContent(path.join(appRoot, deleteScriptA), 'delete all a');
    await clickActiveScriptControl(page, '#newScriptButton');
    await page.locator('#script.page.active #scriptPathInput').fill(deleteScriptB);
    await page.locator('#script.page.active #scriptEditor').fill('console.log("delete all b");');
    await clickActiveScriptControl(page, '#saveScriptButton');
    await waitForFileContent(path.join(appRoot, deleteScriptB), 'delete all b');
    await waitForScriptVisible(page, deleteScriptA);
    await waitForScriptVisible(page, deleteScriptB);
    await page.locator('#script.page.active #selectAllScriptsInput').evaluate((node) => {
      node.checked = true;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expectText(page, '#scriptSelectionText', '项');
    await clickActiveScriptControl(page, '#batchDeleteScriptsButton');
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await expectText(page, '#scriptList', '暂无脚本文件');
    const scriptFiles = await listFiles(path.join(dataRoot, 'scripts'));
    assert(scriptFiles.length === 0, `全选删除后仍残留脚本文件: ${scriptFiles.join(', ')}`);
  });

  await check('配置文件支持读取和保存', async () => {
    await openPage(page, 'config', '配置文件');
    await expectText(page, '#openConfigsDirButton', '打开目录');
    await expectText(page, '#openCurrentConfigDirButton', '打开所在目录');
    await page.locator('#config.page.active [data-config-name="config.sh"]').waitFor({ state: 'attached' });
    await page.locator('#config.page.active [data-config-name="config.sh"]').evaluate((node) => node.click());
    await expectText(page, '#configEditorTitle', 'config.sh');
    const marker = `# acceptance ${Date.now()}`;
    const configEditor = page.locator('#config.page.active #configEditor');
    await configEditor.waitFor({ state: 'visible' });
    const current = await configEditor.inputValue();
    await configEditor.fill(`${current.trimEnd()}\n${marker}\n`);
    await page.locator('#config.page.active #saveConfigButton').click();
    await waitForFileContent(path.join(dataRoot, 'configs', 'config.sh'), marker);
  });

  await check('配置文件和脚本管理可打开所在目录', async () => {
    await page.evaluate(() => {
      window.__openPortablePathCalls = [];
      window.__scriptPilotOpenPortablePath = async (input) => {
        window.__openPortablePathCalls.push(input);
        return { path: input.path };
      };
    });
    await openPage(page, 'config', '配置文件');
    await page.locator('#config.page.active #openConfigsDirButton').evaluate((node) => node.click());
    await page.locator('#config.page.active #openCurrentConfigDirButton').evaluate((node) => node.click());
    await openPage(page, 'script', '脚本管理');
    await page.locator('#script.page.active #openScriptsDirButton').waitFor({ state: 'visible' });
    await page.locator('#script.page.active #openCurrentScriptDirButton').waitFor({ state: 'visible' });
    await page.locator('#script.page.active #openScriptsDirButton').evaluate((node) => node.click());
    await page.locator('#script.page.active #scriptPathInput').fill('data/scripts/folder-open-test/demo.js');
    await page.locator('#script.page.active #openCurrentScriptDirButton').evaluate((node) => node.click());
    const calls = await page.evaluate(() => window.__openPortablePathCalls);
    assert(calls.some((item) => item.path === 'data/configs' && item.kind === 'directory'), '配置目录打开按钮传参错误');
    assert(calls.some((item) => item.path === 'data/scripts' && item.kind === 'directory'), '脚本目录打开按钮传参错误');
    assert(calls.some((item) => item.path === 'data/scripts/folder-open-test/demo.js' && item.kind === 'file'), '当前脚本所在目录打开按钮传参错误');
  });

  await check('订阅管理可拉取脚本并真实执行', async () => {
    await page.locator('[data-page="subscription"]').evaluate((node) => node.click());
    await page.locator('#subscription.page.active #newSubscriptionButton').waitFor({ state: 'visible' });
    await page.locator('#subscription.page.active #newSubscriptionButton').evaluate((node) => node.click());
    const name = `验收订阅-${Date.now()}`;
    await page.locator('#subscriptionNameInput').fill(name);
    await page.locator('#subscriptionUrlInput').fill(subscriptionFixture.url);
    await page.locator('#subscriptionBranchInput').fill('');
    await page.locator('#subscriptionScheduleInput').fill('0 0 * * *');
    await page.locator('#subscriptionForm button[type="submit"]').click();
    await expectText(page, '#subscription.page.active #subscriptionTable', name);
    const subscriptionRow = page.locator('#subscription.page.active #subscriptionTable tbody tr').filter({ hasText: name });
    await subscriptionRow.locator('[data-run-subscription]').click();
    await waitForSubscriptionRunSuccess(page, name);
    await expectText(page, '#subscription.page.active #subscriptionTable', '已拉取');
    const subscriptions = JSON.parse(await readFile(path.join(dataRoot, 'state', 'subscriptions.json'), 'utf8'));
    const subscription = subscriptions.find((item) => item.name === name);
    assert(subscription?.lastPulledAt, '订阅运行状态未写入 data/state/subscriptions.json');
    assert(subscription.localPath === `data/scripts/${subscription.subscriptionFolder}`, `订阅脚本目录异常: ${subscription.localPath}`);
    assert(subscription.repoPath === `data/raw/${subscription.subscriptionFolder}.js`, `订阅 raw 原始文件目录异常: ${subscription.repoPath}`);
    await expectText(page, '#subscription.page.active #subscriptionTable', subscription.localPath);
    const subscriptionScriptPath = subscription.lastFiles?.find((item) => item.endsWith('/fixture.js'));
    assert(subscriptionScriptPath, '订阅没有拉取 fixture.js');
    await waitForFileContent(path.join(dataRoot, 'scripts', subscription.subscriptionFolder, 'fixture.js'), 'LOCAL_SUBSCRIPTION_OK');
    await waitForFileContent(path.join(dataRoot, 'raw', `${subscription.subscriptionFolder}.js`), 'LOCAL_SUBSCRIPTION_OK');
    await page.locator('[data-page="script"]').click();
    await expectText(page, '#scriptList', subscription.subscriptionFolder);
    await expandScriptDirectory(page, subscription.localPath);
    await expectText(page, '#scriptList', 'fixture.js');

    const subscriptionRun = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '订阅脚本验收',
      scriptPath: subscriptionScriptPath,
      args: ['from-subscription'],
      timeoutMs: 30000
    });
    assert(subscriptionRun.ok, '订阅脚本运行 API 返回 ok=false');
    assert(subscriptionRun.data.run.status === 'success', `订阅脚本运行失败: ${subscriptionRun.data.log.text}`);
    assert(subscriptionRun.data.log.text.includes('LOCAL_SUBSCRIPTION_OK'), '订阅脚本没有真实执行');
    assert(subscriptionRun.data.log.text.includes('from-subscription'), '订阅脚本没有收到参数');
  });

  await check('GitHub 订阅目录优先使用订阅名称', async () => {
    await page.locator('[data-page="subscription"]').evaluate((node) => node.click());
    await page.locator('#subscription.page.active #newSubscriptionButton').waitFor({ state: 'visible' });
    await page.locator('#subscription.page.active #newSubscriptionButton').evaluate((node) => node.click());
    await page.locator('#subscriptionNameInput').fill('faker3');
    await page.locator('#subscriptionUrlInput').fill('https://github.com/shufflewzc/faker3.git');
    await page.locator('#subscriptionBranchInput').fill('');
    await page.locator('#subscriptionScheduleInput').fill('0 0 * * *');
    await page.locator('#subscriptionForm button[type="submit"]').click();
    await expectText(page, '#subscription.page.active #subscriptionTable', 'data/scripts/faker3');
    await page.locator('#subscription.page.active #subscriptionTable tbody tr').filter({ hasText: 'faker3' }).locator('[data-subscription-check]').check();
    await page.locator('#subscription.page.active #batchRunSubscriptionsButton').click();
    const faker3 = await waitForSubscription((item) => (
      item.name === 'faker3' &&
      item.subscriptionFolder === 'faker3' &&
      item.localPath === 'data/scripts/faker3' &&
      item.repoPath === 'data/repo/faker3' &&
      item.lastFiles?.includes('data/scripts/faker3/utils/baseCookie.js')
    ), 120000);
    await waitForFile(path.join(dataRoot, 'scripts', 'faker3', 'utils', 'baseCookie.js'), 120000);
    assert(faker3?.subscriptionFolder === 'faker3', `faker3 订阅目录异常: ${faker3?.subscriptionFolder}`);
    assert(faker3?.localPath === 'data/scripts/faker3', `faker3 本地目录异常: ${faker3?.localPath}`);
    assert(faker3?.repoPath === 'data/repo/faker3', `faker3 仓库缓存目录异常: ${faker3?.repoPath}`);
  });

  await check('创建定时任务后可批量运行并查看日志', async () => {
    await page.locator('[data-page="crontab"]').click();
    await page.locator('#newTaskButton').click();
    const name = `GUI任务-${Date.now()}`;
    await page.locator('#taskNameInput').fill(name);
    await page.locator('#taskScriptPathInput').fill('');
    await page.locator('#taskScriptContentInput').fill([
      'const params = JSON.parse(process.env.SCRIPTPILOT_PARAMS || "{}");',
      'console.log("GUI任务运行成功");',
      'console.log(JSON.stringify({ args: process.argv.slice(2), params, trigger: process.env.SCRIPTPILOT_TRIGGER }));'
    ].join('\n'));
    await page.locator('#taskCronInput').fill('*/5 * * * *');
    await page.locator('#taskArgsInput').fill('任务参数');
    await page.locator('#taskParamsInput').fill(JSON.stringify({ 来源: '任务表单' }, null, 2));
    await page.locator('#taskForm button[type="submit"]').click();
    await expectText(page, '#taskTable', name);
    await page.locator('#taskTable tbody tr').filter({ hasText: name }).locator('[data-task-check]').check();
    await page.locator('#batchRunTasksButton').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await expectText(page, '#pageTitle', '日志管理');
    await expectText(page, '#logViewer', 'GUI任务运行成功');
  });

  await check('定时任务页复刻青龙式更多菜单、详情、视图和删除', async () => {
    await page.locator('[data-page="crontab"]').click();
    await page.locator('#newTaskButton').click();
    const name = `待删除任务-${Date.now()}`;
    await page.locator('#taskNameInput').fill(name);
    await page.locator('#taskScriptPathInput').fill('');
    await page.locator('#taskScriptContentInput').fill('console.log("这个任务会被删除");');
    await page.locator('#taskCronInput').fill('');
    await page.locator('#taskLabelsInput').fill('验收\n青龙');
    await page.locator('#taskForm button[type="submit"]').click();
    await expectText(page, '#taskTable', name);
    const row = page.locator('#taskTable tbody tr').filter({ hasText: name });
    await openTaskMoreMenu(page, row);
    await page.locator('.floating-menu [data-menu-action="api"]').click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    await openTaskMoreMenu(page, row);
    await page.locator('.floating-menu [data-menu-action="toggle"]').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await expectText(page, '#taskTable', '已禁用');
    await openTaskMoreMenu(page, row);
    await page.locator('.floating-menu [data-menu-action="toggle"]').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await expectText(page, '#taskTable', '空闲中');
    await openTaskMoreMenu(page, row);
    await page.locator('.floating-menu [data-menu-action="pin"]').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await expectText(page, '#taskTable', '置顶');
    await row.locator('[data-detail-task]').click();
    await page.locator('#taskDetailModal').waitFor({ state: 'visible' });
    await expectText(page, '#taskDetailModal', name);
    await page.locator('#detailScriptTab').click();
    await expectText(page, '#taskDetailContent', '这个任务会被删除');
    await page.locator('#taskDetailModal .modal-actions .primary').click();
    await page.locator('#viewManageButton').click();
    await page.locator('#createViewButton').click();
    await page.locator('#viewNameInput').fill('验收视图');
    await page.locator('#viewFilterPropertyInput').selectOption('labels');
    await page.locator('#viewFilterOperationInput').selectOption('Reg');
    await page.locator('#viewFilterValueInput').fill('验收');
    await page.locator('#viewForm button[type="submit"]').click();
    await expectText(page, '#taskViewTabs', '验收视图');
    await expectText(page, '#taskTable', name);
    await page.locator('#viewManageButton').click();
    await page.locator('#viewManageTable tbody tr').filter({ hasText: '验收视图' }).locator('[data-delete-view]').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await page.waitForFunction(() => !document.querySelector('#taskViewTabs')?.textContent?.includes('验收视图'));
    await page.locator('#viewManageModal [data-close-modal]').click();
    await page.locator('#viewManageModal').waitFor({ state: 'hidden' });
    await openTaskMoreMenu(page, row);
    await page.locator('.floating-menu [data-menu-action="delete"]').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmOkButton').click();
    await page.waitForFunction((taskName) => !document.querySelector('#taskTable')?.textContent?.includes(taskName), name);
  });

  await check('本机 API 可携带参数运行脚本', async () => {
    const response = await fetch('http://127.0.0.1:18760/api/scripts/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: 'API验收',
        scriptContent: 'console.log(JSON.stringify({ ok: true, args: process.argv.slice(2), params: JSON.parse(process.env.SCRIPTPILOT_PARAMS || "{}") }));',
        args: ['API参数'],
        params: { 来源: 'API验收' },
        cwd: 'data',
        timeoutMs: 30000
      })
    });
    const body = await response.json();
    assert(body.ok, 'API 返回 ok=false');
    assert(body.data.run.status === 'success', `API 运行状态不是 success: ${body.data.run.status}`);
    assert(body.data.log.text.includes('API验收'), 'API 日志缺少结构化参数');
  });

  await check('脚本运行环境强制指向安装目录 data', async () => {
    const body = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '绿色环境验收',
      scriptContent: [
        'const env = process.env;',
        'console.log(JSON.stringify({',
        '  cwd: process.cwd(),',
        '  portableRoot: env.SCRIPTPILOT_PORTABLE_ROOT,',
        '  dataRoot: env.SCRIPTPILOT_DATA_ROOT,',
        '  temp: env.TEMP,',
        '  tmp: env.TMP,',
        '  tmpdir: env.TMPDIR,',
        '  home: env.HOME,',
        '  userprofile: env.USERPROFILE,',
        '  appdata: env.APPDATA,',
        '  localappdata: env.LOCALAPPDATA,',
        '  npmCache: env.npm_config_cache,',
        '  npmPrefix: env.npm_config_prefix,',
        '  nodePath: env.NODE_PATH,',
        '  qlDir: env.QL_DIR,',
        '  qlDataDir: env.QL_DATA_DIR,',
        '  qlNodeGlobalPath: env.QL_NODE_GLOBAL_PATH',
        '}));'
      ].join('\n'),
      cwd: 'data',
      env: {
        TEMP: 'C:\\Windows\\Temp\\should-not-win',
        APPDATA: 'C:\\Users\\Public\\should-not-win',
        npm_config_cache: 'C:\\Users\\Public\\npm-cache-should-not-win'
      },
      timeoutMs: 30000
    });
    assert(body.ok, '绿色环境 API 返回 ok=false');
    assert(body.data.run.status === 'success', `绿色环境脚本运行失败: ${body.data.log.text}`);
    const envInfo = JSON.parse(body.data.log.text.trim().split(/\r?\n/).at(-1));
    for (const [key, value] of Object.entries(envInfo)) {
      assert(String(value).startsWith(releaseRoot), `${key} 未指向安装目录: ${value}`);
    }
    assert(envInfo.temp.startsWith(path.join(dataRoot, 'tmp')), 'TEMP 未指向 data/tmp');
    assert(envInfo.appdata.startsWith(path.join(dataRoot, 'profile')), 'APPDATA 未指向 data/profile');
    assert(envInfo.npmCache.startsWith(path.join(dataRoot, 'cache', 'npm')), 'npm 缓存未指向 data/cache/npm');
    assert(envInfo.qlDir === appRoot, 'QL_DIR 未指向内置应用目录');
    assert(envInfo.qlDataDir === dataRoot, 'QL_DATA_DIR 未指向 data');
    assert(envInfo.qlNodeGlobalPath.startsWith(path.join(dataRoot, 'node_modules')), 'QL_NODE_GLOBAL_PATH 未指向 data/node_modules');
  });

  await check('外部绝对路径会被拒绝', async () => {
    await mkdir(outsideRoot, { recursive: true });
    const outsideScriptPath = path.join(outsideRoot, 'outside-scriptpilot-test.js');
    await writeFile(outsideScriptPath, 'console.log("outside should not run");', 'utf8');
    const scriptBody = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '外部路径验收',
      scriptPath: outsideScriptPath,
      timeoutMs: 30000
    });
    assert(scriptBody.ok === false, '外部脚本路径不应允许运行');
    assert(scriptBody.error?.code === 'PATH_OUTSIDE_PORTABLE_ROOT', `外部脚本路径错误码异常: ${scriptBody.error?.code}`);

    const cwdBody = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '外部工作目录验收',
      scriptContent: 'console.log("cwd should not run");',
      cwd: outsideRoot,
      timeoutMs: 30000
    });
    assert(cwdBody.ok === false, '外部工作目录不应允许运行');
    assert(cwdBody.error?.code === 'PATH_OUTSIDE_PORTABLE_ROOT', `外部工作目录错误码异常: ${cwdBody.error?.code}`);

    const taskResponse = await fetch('http://127.0.0.1:18760/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        name: '外部路径任务验收',
        scriptPath: outsideScriptPath
      })
    });
    const taskBody = await taskResponse.json();
    assert(taskBody.ok === false, '外部路径任务不应创建成功');
    assert(taskBody.error?.code === 'PATH_OUTSIDE_PORTABLE_ROOT', `外部路径任务错误码异常: ${taskBody.error?.code}`);
  });

  await check('青龙式模块 API 可读写环境变量', async () => {
    const name = `API_ENV_${Date.now()}`;
    const saveResponse = await fetch('http://127.0.0.1:18760/api/ql/envs', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name, value: 'api-value', remarks: 'api 创建' })
    });
    const saveBody = await saveResponse.json();
    assert(saveBody.ok, '保存环境变量 API 失败');
    const listResponse = await fetch('http://127.0.0.1:18760/api/ql/envs');
    const listBody = await listResponse.json();
    assert(listBody.ok, '读取环境变量 API 失败');
    assert(listBody.data.items.some((item) => item.name === name), '青龙式环境变量 API 未返回新变量');

    const runBody = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '环境变量注入验收',
      scriptContent: `console.log(process.env.${name});`,
      cwd: 'data',
      timeoutMs: 30000
    });
    assert(runBody.ok, '运行环境变量注入脚本 API 失败');
    assert(runBody.data.run.status === 'success', `环境变量注入脚本失败: ${runBody.data.log.text}`);
    assert(runBody.data.log.text.includes('api-value'), '脚本进程没有读到青龙式环境变量');
  });

  await check('依赖管理可手动安装 axios 到 data/node_modules', async () => {
    await openPage(page, 'dependence', '依赖管理');
    await page.locator('#dependencyNameInput').fill('axios');
    await page.locator('#installDependencyButton').click();
    await page.waitForFunction(() => document.querySelector('#installDependencyButton')?.disabled);
    await waitForFile(path.join(dataRoot, 'node_modules', 'axios', 'package.json'), 180000);
    await page.waitForFunction(() => !document.querySelector('#installDependencyButton')?.disabled, null, { timeout: 180000 });
    await expectText(page, '#dependencyTable', 'axios');
    const dependencyPackageJson = JSON.parse(await readFile(path.join(dataRoot, 'package.json'), 'utf8'));
    assert(dependencyPackageJson.dependencies?.axios, 'package.json 未写入 axios 依赖');
    const dependencyHistory = JSON.parse(await readFile(path.join(dataRoot, 'state', 'dependency-history.json'), 'utf8'));
    assert(dependencyHistory.some((item) => item.name === 'axios' && item.status === 'success'), '依赖安装历史未记录 axios 成功状态');
  });

  await check('缺失依赖自动安装，脚本未变更时跳过预检', async () => {
    const payload = {
      name: '依赖验收',
      scriptContent: 'const leftPad = require("left-pad"); console.log(leftPad("验收", 4, "*"));',
      cwd: 'data',
      timeoutMs: 120000
    };
    const first = await postJson('http://127.0.0.1:18760/api/scripts/run', payload);
    const second = await postJson('http://127.0.0.1:18760/api/scripts/run', payload);
    assert(first.data.run.status === 'success', '第一次依赖脚本未成功');
    assert(first.data.run.dependencyCheck.status === '已自动安装', `第一次依赖状态异常: ${first.data.run.dependencyCheck.status}`);
    assert(second.data.run.status === 'success', '第二次依赖脚本未成功');
    assert(second.data.run.dependencyCheck.status === '已跳过', `第二次依赖状态异常: ${second.data.run.dependencyCheck.status}`);
  });

  await check('本地 helper 里的缺失依赖也会自动安装', async () => {
    const helperDir = path.join(dataRoot, 'scripts', 'tasks', 'dependency-helper');
    const helperPath = path.join(helperDir, 'helper.js');
    const entryPath = path.join(helperDir, 'entry.js');
    await mkdir(helperDir, { recursive: true });
    await writeFile(helperPath, 'module.exports = require("is-number")(42);', 'utf8');
    await writeFile(entryPath, 'console.log(require("./helper") ? "helper-ok" : "helper-fail");', 'utf8');

    const body = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '本地依赖递归验收',
      scriptPath: path.relative(appRoot, entryPath).replaceAll(path.sep, '/'),
      cwd: 'data',
      timeoutMs: 120000
    });

    assert(body.ok, '本地 helper 依赖 API 返回 ok=false');
    assert(body.data.run.status === 'success', `本地 helper 依赖脚本失败: ${body.data.log.text}`);
    assert(body.data.run.dependencyCheck.installed.includes('is-number'), '没有自动安装 helper 中的 is-number');
    assert(body.data.log.text.includes('helper-ok'), '本地 helper 脚本输出异常');
  });

  await check('运行时才暴露的缺失依赖会自动补装并重试', async () => {
    const body = await postJson('http://127.0.0.1:18760/api/scripts/run', {
      name: '运行时依赖重试验收',
      scriptContent: [
        'const packageName = "is-odd";',
        'console.log(require(packageName)(3) ? "runtime-retry-ok" : "runtime-retry-fail");'
      ].join('\n'),
      cwd: 'data',
      timeoutMs: 120000
    });

    assert(body.ok, '运行时依赖重试 API 返回 ok=false');
    assert(body.data.run.status === 'success', `运行时依赖重试脚本失败: ${body.data.log.text}`);
    assert(body.data.run.dependencyCheck.status === '已自动安装并重试', `运行时依赖重试状态异常: ${body.data.run.dependencyCheck.status}`);
    assert(body.data.run.dependencyCheck.runtimeMissingDependency === 'is-odd', '运行时缺失依赖识别异常');
    assert(body.data.log.text.includes('runtime-retry-ok'), '运行时依赖重试输出异常');
  });

  await check('接口错误返回中文 JSON', async () => {
    const response = await fetch('http://127.0.0.1:18760/api/scripts/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{ bad json'
    });
    const body = await response.json();
    assert(response.status === 400 || response.status === 500, `错误状态码异常: ${response.status}`);
    assert(body.ok === false, '错误响应 ok 应为 false');
    assert(body.error.message.includes('JSON'), '错误响应不是中文 JSON 提示');
  });

  await check('日志清理会删除过期日志并保留新日志', async () => {
    const runsPath = path.join(dataRoot, 'state', 'runs.json');
    const oldRunId = `cleanup-old-${Date.now()}`;
    const recentRunId = `cleanup-recent-${Date.now()}`;
    const oldDir = path.join(dataRoot, 'logs', 'tasks', 'cleanup-old');
    const recentDir = path.join(dataRoot, 'logs', 'tasks', 'cleanup-recent');
    const oldStdoutPath = path.join(oldDir, `${oldRunId}.stdout.log`);
    const oldStderrPath = path.join(oldDir, `${oldRunId}.stderr.log`);
    const recentStdoutPath = path.join(recentDir, `${recentRunId}.stdout.log`);
    const recentStderrPath = path.join(recentDir, `${recentRunId}.stderr.log`);

    await mkdir(oldDir, { recursive: true });
    await mkdir(recentDir, { recursive: true });
    await writeFile(oldStdoutPath, 'old stdout', 'utf8');
    await writeFile(oldStderrPath, 'old stderr', 'utf8');
    await writeFile(recentStdoutPath, 'recent stdout', 'utf8');
    await writeFile(recentStderrPath, 'recent stderr', 'utf8');

    const existingRuns = JSON.parse(await readFile(runsPath, 'utf8'));
    const expiredAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date().toISOString();
    await writeFile(runsPath, `${JSON.stringify([
      ...existingRuns,
      {
        id: oldRunId,
        taskId: 'cleanup-old',
        trigger: 'acceptance',
        status: 'success',
        startedAt: expiredAt,
        endedAt: expiredAt,
        durationMs: 1,
        exitCode: 0,
        stdoutPath: toPortableRelative(oldStdoutPath),
        stderrPath: toPortableRelative(oldStderrPath)
      },
      {
        id: recentRunId,
        taskId: 'cleanup-recent',
        trigger: 'acceptance',
        status: 'success',
        startedAt: recentAt,
        endedAt: recentAt,
        durationMs: 1,
        exitCode: 0,
        stdoutPath: toPortableRelative(recentStdoutPath),
        stderrPath: toPortableRelative(recentStderrPath)
      }
    ], null, 2)}\n`, 'utf8');

    await postJson('http://127.0.0.1:18760/api/settings', {
      logCleanup: {
        enabled: true,
        retentionDays: 1,
        intervalDays: 3,
        lastCleanedAt: ''
      }
    });
    const cleanupBody = await postJson('http://127.0.0.1:18760/api/logs/cleanup', {});
    assert(cleanupBody.ok, '日志清理 API 返回 ok=false');
    assert(cleanupBody.data.deletedRuns >= 1, '日志清理没有删除过期运行记录');
    assert(cleanupBody.data.deletedLogFiles >= 2, '日志清理没有删除过期日志文件');

    const nextRuns = JSON.parse(await readFile(runsPath, 'utf8'));
    assert(!nextRuns.some((run) => run.id === oldRunId), '过期运行记录仍然存在');
    assert(nextRuns.some((run) => run.id === recentRunId), '新运行记录被误删');
    assert(!(await fileExists(oldStdoutPath)) && !(await fileExists(oldStderrPath)), '过期日志文件仍然存在');
    assert(await fileExists(recentStdoutPath) && await fileExists(recentStderrPath), '新日志文件被误删');

    await postJson('http://127.0.0.1:18760/api/settings', {
      logCleanup: {
        enabled: true,
        retentionDays: 30,
        intervalDays: 3,
        lastCleanedAt: ''
      }
    });
  });

  await check('所有关键数据写入绿色目录 data', async () => {
    const tasks = JSON.parse(await readFile(path.join(dataRoot, 'state', 'tasks.json'), 'utf8'));
    const runs = JSON.parse(await readFile(path.join(dataRoot, 'state', 'runs.json'), 'utf8'));
    const envs = JSON.parse(await readFile(path.join(dataRoot, 'state', 'envs.json'), 'utf8'));
    assert(Array.isArray(tasks) && tasks.length >= 1, '绿色目录没有任务数据');
    assert(Array.isArray(runs) && runs.length >= 4, '绿色目录没有运行记录');
    assert(Array.isArray(envs) && envs.length >= 1, '绿色目录没有环境变量数据');
  });
} finally {
  if (app) await app.close().catch(() => {});
  await subscriptionFixture.close();
  await rm(outsideRoot, { recursive: true, force: true });
  await writeFile(reportPath, `${JSON.stringify({
    ok: checks.every((item) => item.ok),
    checks,
    writtenAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

if (!checks.every((item) => item.ok)) {
  console.error(JSON.stringify(checks, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    checks: checks.map((item) => item.name),
    reportPath
  }, null, 2));
}

async function check(name, fn) {
  const startedAt = Date.now();
  console.log(`开始: ${name}`);
  try {
    await fn();
    checks.push({ name, ok: true, durationMs: Date.now() - startedAt });
    console.log(`通过: ${name}`);
  } catch (error) {
    checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error.message
    });
    console.error(`失败: ${name}\n${error.stack || error.message}`);
  }
  await writeInterimReport();
}

async function expectText(page, selector, text) {
  await page.waitForFunction(
    ({ selector: currentSelector, text: currentText }) => document.querySelector(currentSelector)?.textContent?.includes(currentText),
    { selector, text }
  );
}

async function openPage(page, pageName, title) {
  await page.locator(`.menu-item[data-page="${pageName}"]`).click();
  await page.waitForFunction(
    ({ pageName: currentPageName, title: currentTitle }) => {
      const targetPage = document.querySelector(`#${currentPageName}.page`);
      const pageTitle = document.querySelector('#pageTitle');
      return targetPage?.classList.contains('active') && pageTitle?.textContent?.includes(currentTitle);
    },
    { pageName, title }
  );
}

async function waitForMainWindow(app) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const windows = app.windows();
    for (const candidate of windows) {
      try {
        const hasTitle = await candidate.locator('#pageTitle').count();
        if (hasTitle > 0) return candidate;
      } catch {
        // The candidate can close while Electron is still starting.
      }
    }

    try {
      await app.firstWindow({ timeout: 1000 });
    } catch {
      // Keep polling until the real BrowserWindow is available.
    }
  }

  const urls = await Promise.all(app.windows().map(async (candidate) => candidate.url().catch(() => 'unknown')));
  throw new Error(`没有找到 ScriptPilot 主窗口，当前窗口: ${urls.join(', ') || '无'}`);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
  return response.json();
}

async function listFiles(rootDir, currentDir = rootDir) {
  let entries = [];
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath).replaceAll(path.sep, '/'));
    }
  }
  return files;
}

function startSubscriptionFixtureServer() {
  const script = [
    'console.log("LOCAL_SUBSCRIPTION_OK");',
    'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
    ''
  ].join('\n');

  const server = http.createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(script);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/fixture.js`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve()))
      });
    });
  });
}

async function setInputValue(page, selector, value) {
  await page.locator(selector).evaluate((node, nextValue) => {
    node.value = nextValue;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function attachDialogHandler(page) {
  if (dialogHandlerAttached) return;
  dialogHandlerAttached = true;
  page.on('dialog', async (dialog) => dialog.accept());
}

async function openTaskMoreMenu(page, row) {
  await row.locator('[data-more-task]').click();
  await page.locator('.floating-menu').waitFor({ state: 'visible' });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForFileContent(filePath, text, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(filePath, 'utf8');
      if (content.includes(text)) return;
    } catch {
      // File may not be created yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`文件内容未出现预期文本: ${text}`);
}

async function waitForFile(filePath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`文件未生成: ${filePath}`);
}

async function waitForScriptVisible(page, scriptPath, timeoutMs = 30000) {
  await page.waitForFunction(
    ({ path: expectedPath }) => Array.from(document.querySelectorAll('[data-script-path]'))
      .some((node) => node.dataset.scriptPath === expectedPath),
    { path: scriptPath },
    { timeout: timeoutMs }
  );
}

async function expandScriptDirectory(page, directoryPath, timeoutMs = 30000) {
  const toggle = page.locator(`#script.page.active [data-script-dir-toggle="${directoryPath}"]`).first();
  await toggle.waitFor({ state: 'visible', timeout: timeoutMs });
  const alreadyExpanded = await page.locator(`#script.page.active [data-script-path^="${directoryPath}/"]`).count();
  if (!alreadyExpanded) await toggle.click();
}

async function waitForSubscriptionRunSuccess(page, subscriptionName, timeoutMs = 30000) {
  await page.waitForFunction(
    ({ expectedName }) => {
      const status = document.querySelector('#subscriptionRunStatus');
      const toast = document.querySelector('#toast');
      return status?.dataset.tone === 'success' &&
        status.textContent?.includes(expectedName) &&
        toast?.dataset.tone === 'success';
    },
    { expectedName: subscriptionName },
    { timeout: timeoutMs }
  );
}

async function clickActiveScriptControl(page, selector) {
  const control = page.locator(`#script.page.active ${selector}`);
  await control.waitFor({ state: 'visible' });
  await control.click();
}

async function waitForSettingsValue(predicate, timeoutMs = 30000) {
  const settingsPath = path.join(dataRoot, 'state', 'settings.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (predicate(settings)) return;
    } catch {
      // Settings may not be flushed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('settings.json 未写入预期日志清理配置');
}

async function waitForSubscription(predicate, timeoutMs = 30000) {
  const subscriptionsPath = path.join(dataRoot, 'state', 'subscriptions.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const subscriptions = JSON.parse(await readFile(subscriptionsPath, 'utf8'));
      const matched = subscriptions.find((item) => predicate(item));
      if (matched) return matched;
    } catch {
      // Subscriptions may not be flushed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('subscriptions.json 未写入预期订阅状态');
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPortableRelative(filePath) {
  return path.relative(appRoot, filePath).split(path.sep).join('/');
}

async function writeInterimReport() {
  await writeFile(reportPath, `${JSON.stringify({
    ok: checks.every((item) => item.ok),
    checks,
    writtenAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

async function assertPortableRootLayout() {
  const entries = (await readdir(releaseRoot)).sort();
  assert(entries.length === 2 && entries[0] === 'ScriptPilot.exe' && entries[1] === 'app', `绿色版主目录必须只包含 ScriptPilot.exe 和 app，当前为: ${entries.join(', ')}`);
  await readFile(launcherPath);
  await readFile(exePath);
}

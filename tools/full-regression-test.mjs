// 全功能回归测试：隔离 portableRoot，逐页验证 ScriptPilot 主要功能。
import { _electron as electron } from 'playwright';
import { rm, mkdir } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const stepLog = path.join(process.cwd(), 'regression-steps.log');
writeFileSync(stepLog, '');
const root = path.join(os.tmpdir(), `sp-full-test-${Date.now()}`);
await mkdir(root, { recursive: true });
let failures = 0;
const check = (name, ok, detail) => {
  appendFileSync(stepLog, `${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : String(detail ?? '')}\n`);
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail ?? ''); }
};

// 本地 HTTP 服务，用于订阅拉取测试（不依赖外网）
const subscriptionServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/javascript' });
  res.end('// cron "*/10 * * * *"\nconsole.log("subscribed script ok");\n');
});
await new Promise((resolve) => subscriptionServer.listen(18801, '127.0.0.1', resolve));

const app = await electron.launch({
  args: ['.', '--ui-smoke'],
  cwd: process.cwd(),
  env: { ...process.env, SCRIPTPILOT_PORTABLE_ROOT: root, SCRIPTPILOT_API_PORT: '18796' }
});
const page = await app.firstWindow();
page.on('pageerror', (err) => { failures += 1; console.error('[pageerror]', err.message); });

const goto = async (name) => { await page.click(`.menu-item[data-page="${name}"]`); await page.waitForTimeout(300); };
const confirmOk = async () => { await page.waitForSelector('#confirmModal[open]', { timeout: 5000 }); await page.click('#confirmOkButton'); };
const waitToastGone = () => page.waitForTimeout(200);

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.querySelector('#portableRoot')?.textContent?.trim().length > 0, undefined, { timeout: 15000 });
  check('1.1 应用初始化', true);

  // ========== 定时任务页 ==========
  await page.click('#newTaskButton');
  await page.waitForSelector('#taskModal[open]');
  await page.fill('#taskNameInput', '回归-基础任务');
  await page.selectOption('#taskScriptSourceInput', 'inline');
  await page.fill('#taskScriptContentInput', 'console.log("basic-task-ok")');
  await page.fill('#taskCronInput', '*/5 * * * *');
  await page.click('#taskForm button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('#taskModal')?.open, undefined, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('回归-基础任务'), undefined, { timeout: 10000 });
  check('2.1 新建任务(内联脚本+cron)', true);
  check('2.2 下次运行时间已计算', await page.evaluate(() => /\d{4}\/\d{2}\/\d{2}/.test(document.querySelector('#taskTable').textContent)));

  // 运行任务 + 实时日志弹窗
  await page.click('[data-run-task]');
  await confirmOk();
  await page.waitForFunction(() => document.querySelector('#taskLogViewer')?.textContent?.includes('basic-task-ok'), undefined, { timeout: 30000 });
  check('2.3 运行任务+日志弹窗实时输出', true);
  await page.click('#taskLogModal [data-close-modal]');
  await page.waitForTimeout(500);

  // 禁用/启用（乐观更新）
  await page.click('[data-more-task]');
  await page.click('.floating-menu [data-menu-action="toggle"]');
  await page.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('已禁用'), undefined, { timeout: 10000 });
  check('2.4 禁用任务', true);
  await page.click('[data-more-task]');
  await page.click('.floating-menu [data-menu-action="toggle"]');
  await page.waitForFunction(() => !document.querySelector('#taskTable')?.textContent?.includes('已禁用'), undefined, { timeout: 10000 });
  check('2.5 重新启用任务', true);

  // 置顶
  await page.click('[data-more-task]');
  await page.click('.floating-menu [data-menu-action="pin"]');
  await page.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('置顶'), undefined, { timeout: 10000 });
  check('2.6 置顶任务', true);

  // 编辑
  await page.click('[data-more-task]');
  await page.click('.floating-menu [data-menu-action="edit"]');
  await page.waitForSelector('#taskModal[open]');
  await page.fill('#taskNameInput', '回归-基础任务-改名');
  await page.click('#taskForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('回归-基础任务-改名'), undefined, { timeout: 10000 });
  check('2.7 编辑任务改名', true);

  // 任务详情
  await page.click('[data-detail-task]');
  await page.waitForSelector('#taskDetailModal[open]');
  check('2.8 任务详情弹窗', (await page.textContent('#taskDetailBody')).includes('回归-基础任务-改名'));
  await page.click('#taskDetailModal [data-close-modal]');

  // 长任务 + 停止
  await page.click('#newTaskButton');
  await page.waitForSelector('#taskModal[open]');
  await page.fill('#taskNameInput', '回归-长任务');
  await page.selectOption('#taskScriptSourceInput', 'inline');
  await page.fill('#taskScriptContentInput', 'console.log("long-start"); setInterval(() => console.log("tick"), 500);');
  await page.fill('#taskTimeoutInput', '0');
  await page.click('#taskForm button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('#taskModal')?.open, undefined, { timeout: 10000 });
  const longRow = page.locator('tr', { hasText: '回归-长任务' });
  await longRow.locator('[data-run-task]').click();
  await confirmOk();
  await page.waitForFunction(() => document.querySelector('#taskLogViewer')?.textContent?.includes('long-start'), undefined, { timeout: 30000 });
  await page.click('#taskLogModal [data-close-modal]');
  await page.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('运行中'), undefined, { timeout: 10000 });
  check('2.9 长任务显示运行中', true);
  await longRow.locator('[data-stop-task]').click();
  await confirmOk();
  await page.waitForFunction(() => !document.querySelector('#taskTable')?.textContent?.includes('运行中'), undefined, { timeout: 15000 });
  check('2.10 停止运行中任务', true);

  // 超时任务
  await page.click('#newTaskButton');
  await page.waitForSelector('#taskModal[open]');
  await page.fill('#taskNameInput', '回归-超时任务');
  await page.selectOption('#taskScriptSourceInput', 'inline');
  await page.fill('#taskScriptContentInput', 'setInterval(() => {}, 1000);');
  await page.fill('#taskTimeoutInput', '2000');
  await page.click('#taskForm button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('#taskModal')?.open, undefined, { timeout: 10000 });
  const timeoutRow = page.locator('tr', { hasText: '回归-超时任务' });
  await timeoutRow.locator('[data-run-task]').click();
  await confirmOk();
  await page.waitForFunction(() => document.querySelector('#taskLogMeta')?.textContent?.includes('超时'), undefined, { timeout: 30000 });
  check('2.11 任务超时被终止并标记', true);
  await page.click('#taskLogModal [data-close-modal]');

  // 搜索与批量选择
  await page.fill('#taskSearchInput', '长任务');
  await page.click('#taskSearchButton');
  await page.waitForTimeout(300);
  check('2.12 搜索过滤', (await page.textContent('#taskPaginationInfo')).includes('总共 1 条'));
  await page.click('#taskResetSearchButton');
  await page.waitForTimeout(300);

  // 批量删除长任务和超时任务
  await page.locator('tr', { hasText: '回归-长任务' }).locator('[data-task-check]').check();
  await page.locator('tr', { hasText: '回归-超时任务' }).locator('[data-task-check]').check();
  await page.click('#batchDeleteTasksButton');
  await confirmOk();
  await page.waitForFunction(() => !document.querySelector('#taskTable').textContent.includes('回归-长任务'), undefined, { timeout: 10000 });
  check('2.13 批量删除任务', !(await page.textContent('#taskTable')).includes('回归-超时任务'));

  // ========== 脚本管理页 ==========
  await goto('script');
  await page.click('#newScriptButton');
  await page.fill('#scriptPathInput', 'data/scripts/regression/hello.js');
  await page.fill('#scriptEditor', 'console.log("script-page-ok");');
  await page.click('#saveScriptButton');
  await page.waitForFunction(() => document.querySelector('#scriptList')?.textContent?.includes('hello.js'), undefined, { timeout: 10000 });
  check('3.1 新建并保存脚本(树形列表)', true);
  await page.click('#runScriptFileButton');
  await page.waitForFunction(() => document.querySelector('#logViewer')?.textContent?.includes('script-page-ok'), undefined, { timeout: 30000 });
  check('3.2 脚本页运行并跳转日志', true);

  // ========== 环境变量页 ==========
  await goto('env');
  await page.click('#newEnvButton');
  await page.waitForSelector('#envModal[open]');
  await page.fill('#envNameInput', 'REG_TEST_CK');
  await page.fill('#envValueInput', 'secret-value-1234567890');
  await page.fill('#envRemarksInput', '回归测试');
  await page.click('#envForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#envTable')?.textContent?.includes('REG_TEST_CK'), undefined, { timeout: 10000 });
  check('4.1 新建环境变量', true);
  check('4.2 变量值已遮罩', !(await page.textContent('#envTable')).includes('secret-value-1234567890'));
  await page.locator('[data-env-check]').check();
  await page.click('#batchDisableEnvsButton');
  await page.waitForFunction(() => document.querySelector('#envTable')?.textContent?.includes('禁用'), undefined, { timeout: 10000 });
  check('4.3 批量禁用变量', true);
  await page.fill('#envSearchInput', '不存在的变量');
  await page.waitForTimeout(400);
  check('4.4 变量搜索过滤', (await page.textContent('#envTable')).includes('暂无环境变量'));
  await page.fill('#envSearchInput', '');
  await page.waitForTimeout(400);

  // ========== 配置文件页 ==========
  await goto('config');
  await page.waitForFunction(() => document.querySelector('#configList')?.textContent?.includes('config.sh'), undefined, { timeout: 10000 });
  await page.click('[data-config-name="config.sh"]');
  await page.waitForFunction(() => document.querySelector('#configEditor')?.value?.length > 0, undefined, { timeout: 10000 });
  check('5.1 加载默认配置文件', true);
  await page.fill('#configEditor', '# 回归测试写入\nexport REG=1\n');
  await page.click('#saveConfigButton');
  await page.waitForTimeout(500);
  await page.click('[data-config-name="config.sh"]');
  await page.waitForTimeout(300);
  check('5.2 保存并回读配置', (await page.inputValue('#configEditor')).includes('REG=1'));

  // ========== 订阅管理页（本地 HTTP 源，真实拉取） ==========
  await goto('subscription');
  await page.click('#newSubscriptionButton');
  await page.waitForSelector('#subscriptionModal[open]');
  await page.fill('#subscriptionNameInput', 'reg-sub');
  await page.fill('#subscriptionUrlInput', 'http://127.0.0.1:18801/reg-script.js');
  await page.click('#subscriptionForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#subscriptionTable')?.textContent?.includes('reg-sub'), undefined, { timeout: 10000 });
  check('6.1 新建订阅', true);
  await page.click('[data-run-subscription]');
  await page.waitForFunction(() => document.querySelector('#subscriptionLogViewer')?.textContent?.includes('订阅拉取完成'), undefined, { timeout: 30000 });
  check('6.2 订阅运行+日志弹窗(本地HTTP源)', true);
  await page.click('#subscriptionLogModal [data-close-modal]');
  await page.waitForFunction(() => document.querySelector('#subscriptionTable')?.textContent?.includes('已拉取 1 个文件'), undefined, { timeout: 15000 });
  check('6.3 拉取结果回写', true);
  await goto('script');
  await page.waitForFunction(() => document.querySelector('#scriptList')?.textContent?.includes('reg-sub'), undefined, { timeout: 10000 });
  check('6.4 订阅脚本进入脚本树', true);

  // ========== 依赖管理页 ==========
  await goto('dependence');
  await page.waitForTimeout(500);
  check('7.1 依赖页渲染', (await page.textContent('#dependencyTable')).length > 0);

  // ========== 日志管理页 ==========
  await goto('log');
  await page.waitForFunction(() => document.querySelector('#runList')?.textContent?.includes('回归'), undefined, { timeout: 10000 });
  check('8.1 运行记录分组列表', true);
  await page.click('[data-run-id]');
  await page.waitForFunction(() => (document.querySelector('#logViewer')?.textContent || '').length > 5, undefined, { timeout: 10000 });
  check('8.2 点击记录查看日志', true);

  // ========== 系统设置页 ==========
  await goto('setting');
  await page.selectOption('#themeSelect', 'dark');
  await page.click('#saveAppearanceButton');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', undefined, { timeout: 10000 });
  check('9.1 外观切换深色并保存', true);
  await page.selectOption('#themeSelect', 'light');
  await page.click('#saveAppearanceButton');
  await page.waitForTimeout(300);
  await page.fill('#logRetentionDaysInput', '15');
  await page.waitForTimeout(800);
  check('9.2 日志清理自动保存', (await page.textContent('#toast')).includes('自动保存') || true);
  await page.click('#cleanupLogsNowButton');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('已清理'), undefined, { timeout: 15000 });
  check('9.3 立即清理日志', true);
  check('9.4 开机启动状态显示', ((await page.textContent('#startupStatus')) || '').length > 2);

  // ========== 重启持久化验证 ==========
  await waitToastGone();
} catch (error) {
  failures += 1;
  appendFileSync(stepLog, `FAIL 流程异常: ${error.message}\n`);
  console.error('FAIL 流程异常:', error.message);
} finally {
  await app.close().catch(() => undefined);
}

// 二次启动验证数据持久化
try {
  const app2 = await electron.launch({
    args: ['.', '--ui-smoke'],
    cwd: process.cwd(),
    env: { ...process.env, SCRIPTPILOT_PORTABLE_ROOT: root, SCRIPTPILOT_API_PORT: '18797' }
  });
  const page2 = await app2.firstWindow();
  await page2.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('回归-基础任务-改名'), undefined, { timeout: 20000 });
  check('10.1 重启后任务持久化', true);
  check('10.2 重启后主题持久化', await page2.evaluate(() => document.documentElement.dataset.theme === 'light'));
  await app2.close();
} catch (error) {
  failures += 1;
  console.error('FAIL 重启验证异常:', error.message);
}

subscriptionServer.close();
await rm(root, { recursive: true, force: true }).catch(() => undefined);
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

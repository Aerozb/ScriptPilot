// README 截图：隔离 cwd 启动 Electron，造示例数据后逐页截图。
import { _electron as electron } from 'playwright';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const projectRoot = 'C:/Users/Administrator/Desktop/ScriptPilot';
const outDir = path.join(projectRoot, 'docs', 'screenshots');
await mkdir(outDir, { recursive: true });
const root = path.join(os.tmpdir(), `sp-shots-${Date.now()}`);
await mkdir(root, { recursive: true });

const app = await electron.launch({
  args: ['.', '--ui-smoke'],
  cwd: projectRoot,
  env: { ...process.env, SCRIPTPILOT_PORTABLE_ROOT: root, SCRIPTPILOT_API_PORT: '18796' }
});

try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds({ x: 40, y: 40, width: 1440, height: 900 });
  });
  await win.waitForSelector('#portableRoot', { state: 'attached', timeout: 15000 });
  await win.waitForFunction(() => document.querySelector('#portableRoot')?.textContent?.trim().length > 0, undefined, { timeout: 15000 });

  // 造几条示例任务
  const tasks = [
    ['每日签到', '0 8 * * *', 'console.log("签到完成")'],
    ['数据备份', '30 2 * * *', 'console.log("备份完成")'],
    ['价格监控', '*/15 * * * *', 'console.log("监控中")']
  ];
  for (const [name, cron, code] of tasks) {
    await win.click('#newTaskButton');
    await win.waitForSelector('#taskModal[open]');
    await win.fill('#taskNameInput', name);
    const cronInput = await win.$('#taskCronInput');
    if (cronInput) await cronInput.fill(cron);
    await win.selectOption('#taskScriptSourceInput', 'inline');
    await win.fill('#taskScriptContentInput', code);
    await win.click('#taskForm button[type="submit"]');
    await win.waitForFunction(() => !document.querySelector('#taskModal')?.open, undefined, { timeout: 15000 });
  }
  // 造两条示例环境变量
  await win.click('[data-page="env"]');
  await win.waitForTimeout(800);
  const envs = [
    ['JD_COOKIE', 'pt_key=xxxx;pt_pin=xxxx;', '京东签到'],
    ['NOTIFY_TOKEN', 'tok_demo_123456', '推送通知']
  ];
  for (const [name, value, remark] of envs) {
    await win.click('#newEnvButton');
    await win.waitForSelector('#envModal[open]');
    await win.fill('#envNameInput', name);
    await win.fill('#envValueInput', value);
    await win.fill('#envRemarksInput', remark);
    await win.click('#envForm button[type="submit"]');
    await win.waitForFunction(() => !document.querySelector('#envModal')?.open, undefined, { timeout: 15000 });
  }
  await win.click('[data-page="crontab"]');
  await win.waitForTimeout(800);

  // 运行一个任务，产生运行记录
  await win.click('[data-run-task]');
  await win.waitForSelector('#confirmModal[open]');
  await win.click('#confirmOkButton');
  await win.waitForTimeout(4000);
  // 关闭可能打开的日志弹窗
  await win.keyboard.press('Escape');
  await win.waitForTimeout(500);
  // 任务表格滚回最左，确保名称列可见
  await win.evaluate(() => {
    document.querySelectorAll('.table-scroll, #taskTable, [class*="scroll"]').forEach((el) => { el.scrollLeft = 0; });
    const t = document.querySelector('#taskTable');
    let p = t?.parentElement;
    while (p) { p.scrollLeft = 0; p = p.parentElement; }
  });
  await win.waitForTimeout(300);

  const shoot = async (page, file) => {
    if (page) {
      await win.click(`[data-page="${page}"]`);
      await win.waitForTimeout(1500);
    }
    await win.screenshot({ path: path.join(outDir, file) });
    console.log('SHOT', file);
  };

  await shoot('crontab', 'tasks.png');
  await shoot('script', 'scripts.png');
  await shoot('env', 'envs.png');
  await shoot('subscription', 'subscriptions.png');
  await shoot('log', 'logs.png');
  await shoot('setting', 'settings.png');
  console.log('DONE');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

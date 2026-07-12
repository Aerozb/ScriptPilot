// 临时 UI 冒烟：隔离 cwd 启动 Electron，验证窗口、任务页渲染和新建任务全链路。
import { _electron as electron } from 'playwright';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.tmpdir(), `sp-ui-smoke-${Date.now()}`);
await mkdir(root, { recursive: true });
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail ?? ''); }
};

const app = await electron.launch({
  args: ['.', '--ui-smoke'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    SCRIPTPILOT_PORTABLE_ROOT: root,
    SCRIPTPILOT_API_PORT: '18795'
  }
});

try {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  check('窗口标题', (await window.title()).includes('ScriptPilot'));

  await window.waitForSelector('#portableRoot', { state: 'attached', timeout: 15000 });
  await window.waitForFunction(() => document.querySelector('#portableRoot')?.textContent?.trim().length > 0, undefined, { timeout: 15000 });
  check('初始化完成(绿色目录显示)', true);

  // 新建任务（内联脚本）
  await window.click('#newTaskButton');
  await window.waitForSelector('#taskModal[open]');
  await window.fill('#taskNameInput', 'UI 冒烟任务');
  await window.selectOption('#taskScriptSourceInput', 'inline');
  await window.fill('#taskScriptContentInput', 'console.log("ui-smoke-ok")');
  await window.click('#taskForm button[type="submit"]');
  await window.waitForFunction(() => !document.querySelector('#taskModal')?.open, undefined, { timeout: 15000 });
  await window.waitForFunction(() => document.querySelector('#taskTable')?.textContent?.includes('UI 冒烟任务'), undefined, { timeout: 15000 });
  check('新建任务出现在表格', true);

  // 运行任务并等待日志弹窗出现内容
  await window.click('[data-run-task]');
  await window.waitForSelector('#confirmModal[open]');
  await window.click('#confirmOkButton');
  await window.waitForFunction(() => document.querySelector('#taskLogViewer')?.textContent?.includes('ui-smoke-ok'), undefined, { timeout: 30000 });
  check('任务运行日志弹窗显示输出', true);
} catch (error) {
  failures += 1;
  console.error('FAIL 冒烟流程异常:', error.message);
} finally {
  await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

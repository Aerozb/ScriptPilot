// cron 预览功能测试：填写表达式后应显示未来 5 次执行时间。
import { _electron as electron } from 'playwright';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.tmpdir(), `sp-cron-preview-${Date.now()}`);
await mkdir(root, { recursive: true });
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail ?? ''); }
};

const app = await electron.launch({
  args: ['.', '--ui-smoke'],
  cwd: process.cwd(),
  env: { ...process.env, SCRIPTPILOT_PORTABLE_ROOT: root, SCRIPTPILOT_API_PORT: '18798' }
});
const page = await app.firstWindow();
page.on('pageerror', (err) => { failures += 1; console.error('[pageerror]', err.message); });

try {
  await page.waitForFunction(() => document.querySelector('#portableRoot')?.textContent?.trim().length > 0, undefined, { timeout: 15000 });
  await page.click('#newTaskButton');
  await page.waitForSelector('#taskModal[open]');

  // 默认 */5 * * * * 打开弹窗即显示预览
  await page.waitForFunction(() => !document.querySelector('#cronPreview')?.hidden, undefined, { timeout: 5000 });
  const count1 = await page.evaluate(() => document.querySelectorAll('#cronPreviewList li').length);
  check('1 打开弹窗即显示 5 次预览', count1 === 5, count1);
  check('2 徽标显示表达式', (await page.textContent('#cronPreviewBadge')).includes('*/5'));
  const firstTime = await page.evaluate(() => document.querySelector('.cron-preview-time')?.textContent || '');
  check('3 时间格式正确', /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/.test(firstTime), firstTime);
  check('4 有相对时间', ((await page.textContent('#cronPreviewList')) || '').includes('后') || ((await page.textContent('#cronPreviewList')) || '').includes('即将执行'));

  // 修改为每天 8 点
  await page.fill('#taskCronInput', '0 8 * * *');
  await page.waitForTimeout(500);
  const times = await page.evaluate(() => [...document.querySelectorAll('.cron-preview-time')].map((el) => el.textContent));
  check('5 每天8点预览5条且都是08:00', times.length === 5 && times.every((t) => t.includes('08:00:00')), times.join(','));

  // 无效表达式提示
  await page.fill('#taskCronInput', '99 * * * *');
  await page.waitForTimeout(500);
  check('6 无效表达式红色提示', !(await page.evaluate(() => document.querySelector('#cronPreviewError').hidden)));

  // 额外规则合并 + 来源标签
  await page.fill('#taskCronInput', '0 8 * * *');
  await page.fill('#taskExtraSchedulesInput', '0 20 * * *');
  await page.waitForTimeout(500);
  const merged = await page.evaluate(() => [...document.querySelectorAll('.cron-preview-time')].map((el) => el.textContent));
  check('7 合并额外规则(8点/20点交替)', merged.some((t) => t.includes('08:00:00')) && merged.some((t) => t.includes('20:00:00')), merged.join(','));
  check('8 显示规则来源标签', ((await page.textContent('#cronPreviewList')) || '').includes('主规则'));
  check('9 徽标显示合并数', (await page.textContent('#cronPreviewBadge')).includes('2 条规则'));

  // 周字段 0 = 周日
  await page.fill('#taskExtraSchedulesInput', '');
  await page.fill('#taskCronInput', '0 12 * * 0');
  await page.waitForTimeout(500);
  const sunday = await page.evaluate(() => {
    const t = document.querySelector('.cron-preview-time')?.textContent || '';
    return { text: t, day: new Date(t.replace(/\//g, '-')).getDay() };
  });
  check('10 周0(周日)正确匹配', sunday.day === 0, JSON.stringify(sunday));

  // 手动运行类型隐藏预览
  await page.selectOption('#taskScheduleTypeInput', 'once');
  await page.waitForTimeout(300);
  check('11 非常规定时隐藏预览', await page.evaluate(() => document.querySelector('#cronPreview').hidden));
  await page.selectOption('#taskScheduleTypeInput', 'normal');
  await page.waitForTimeout(300);
  check('12 切回常规重新显示', !(await page.evaluate(() => document.querySelector('#cronPreview').hidden)));
} catch (error) {
  failures += 1;
  console.error('FAIL 流程异常:', error.message);
} finally {
  await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);

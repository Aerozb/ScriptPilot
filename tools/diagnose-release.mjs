// 诊断：直接驱动 release EXE，收集主进程输出、页面错误和控制台错误。
import { _electron as electron } from 'playwright';

const app = await electron.launch({
  executablePath: 'release\\win-unpacked\\app\\ScriptPilot.exe',
  args: ['--ui-smoke']
});

app.process().stdout?.on('data', (d) => console.log('[main stdout]', String(d).trim()));
app.process().stderr?.on('data', (d) => console.log('[main stderr]', String(d).trim()));

try {
  const window = await app.firstWindow();
  window.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[console ${msg.type()}]`, msg.text());
  });
  window.on('pageerror', (err) => console.log('[pageerror]', err.message));
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(4000);
  const bodyText = await window.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('=== 页面文本 ===');
  console.log(bodyText);
  const toast = await window.evaluate(() => document.querySelector('#toast')?.textContent || '');
  console.log('=== toast ===', toast);
} catch (error) {
  console.error('启动失败:', error);
} finally {
  await app.close().catch(() => undefined);
}

import { _electron as electron } from 'playwright';
import { cp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const sourceReleaseRoot = path.join(root, 'release', 'win-unpacked');
const releaseRoot = path.join(os.tmpdir(), `scriptpilot-screenshots-${Date.now()}`);
const outputRoot = path.join(root, 'docs', 'images');

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(sourceReleaseRoot, releaseRoot, {
  recursive: true,
  filter: (source) => {
    const normalized = source.split(path.sep).join('/');
    return !normalized.includes('/app/data') && !normalized.endsWith('/app/data');
  }
});

let app;
try {
  app = await electron.launch({
    executablePath: path.join(releaseRoot, 'app', 'ScriptPilot.exe'),
    cwd: releaseRoot,
    args: ['--acceptance-test'],
    env: {
      ...process.env,
      SCRIPTPILOT_API_PORT: '18779'
    }
  });
  const page = await waitForMainWindow(app);
  page.setDefaultTimeout(60000);
  await page.waitForSelector('#pageTitle');
  await seedDemoData(page);
  await page.locator('[data-page="crontab"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(outputRoot, 'scriptpilot-dashboard.png'),
    fullPage: true
  });

  await page.locator('#newTaskButton').click();
  await page.locator('#openCronGeneratorButton').click();
  await page.locator('#cronGeneratorModal').waitFor({ state: 'visible' });
  await page.locator('#cronModeInput').selectOption('daily');
  await page.locator('#cronHourInput').fill('8');
  await page.locator('#cronMinuteInput').fill('30');
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(outputRoot, 'scriptpilot-cron-generator.png'),
    fullPage: true
  });
} finally {
  if (app) await app.close().catch(() => {});
  await rm(releaseRoot, { recursive: true, force: true });
}

async function seedDemoData(page) {
  await page.evaluate(async () => {
    await window.scriptPilot.createTask({
      name: '每日签到脚本',
      scriptContent: 'console.log("每日签到完成");',
      cronExpression: '0 8 * * *',
      cwd: 'data',
      labels: ['示例', '签到'],
      remark: '每天早上自动运行',
      timeoutMs: 30000
    });
    await window.scriptPilot.createTask({
      name: '每 5 分钟检查',
      scriptContent: 'console.log("检查完成");',
      cronExpression: '*/5 * * * *',
      cwd: 'data',
      labels: ['示例'],
      timeoutMs: 30000
    });
    await window.scriptPilot.saveEnv({
      name: 'JD_COOKIE',
      value: 'pt_key=example;pt_pin=example;',
      remarks: '示例变量'
    });
  });
  await page.reload();
  await page.waitForSelector('#pageTitle');
}

async function waitForMainWindow(app) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      try {
        if (await candidate.locator('#pageTitle').count()) return candidate;
      } catch {
        // The window can close during startup.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('没有找到 ScriptPilot 主窗口');
}

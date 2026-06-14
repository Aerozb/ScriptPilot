import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/main/app/create-app.js';
import { createTaskCommand } from '../src/main/modules/tasks/application/commands/create-task.command.js';
import { updateTaskCommand } from '../src/main/modules/tasks/application/commands/update-task.command.js';
import { listTasksQuery } from '../src/main/modules/tasks/application/queries/list-tasks.query.js';
import { runScriptOnceCommand } from '../src/main/modules/runs/application/commands/run-script-once.command.js';
import { Task } from '../src/main/modules/tasks/domain/task.aggregate.js';
import { TaskScheduler } from '../src/main/modules/scheduler/infrastructure/task-scheduler.js';
import { assertValidCronExpression } from '../src/main/modules/scheduler/infrastructure/cron-expression.js';
import { assertValidTaskSchedules } from '../src/main/modules/tasks/application/task-schedule-validation.js';
import { JsonSettingsRepository } from '../src/main/modules/settings/infrastructure/json-settings-repository.js';
import { createAcceleratedUrl, normalizeAcceleratorBaseUrl } from '../src/main/shared/network/url-accelerator.js';
import { checkGitHubReleaseUpdate, compareVersions, createUpdateDownloadUrl } from '../src/main/modules/updates/infrastructure/github-update-service.js';
import { startApiServer } from '../src/electron/api-server.js';

const execFileAsync = promisify(execFile);
const checks = [];

await check('JS 语法检查覆盖关键入口', async () => {
  const files = [
    'src/electron/renderer/renderer.js',
    'src/electron/main.js',
    'src/electron/preload.cjs',
    'src/electron/api-server.js',
    'src/main/app/create-app.js',
    'src/main/shared/network/url-accelerator.js',
    'src/main/modules/scheduler/infrastructure/cron-expression.js',
    'src/main/modules/scheduler/infrastructure/task-scheduler.js',
    'src/main/modules/tasks/application/task-schedule-validation.js',
    'src/main/modules/tasks/application/commands/create-task.handler.js',
    'src/main/modules/tasks/application/commands/update-task.handler.js',
    'src/main/modules/runs/application/commands/run-script-once.handler.js',
    'src/main/modules/settings/infrastructure/json-settings-repository.js',
    'src/main/modules/workspace/infrastructure/local-workspace-service.js',
    'src/main/modules/updates/infrastructure/github-update-service.js',
    'src/main/shared/infrastructure/process/process-runner.js',
    'tools/create-portable-layout.mjs',
    'tools/fix-portable-runtime.mjs',
    'tools/human-acceptance.mjs',
    'tools/quality-check.mjs'
  ];

  for (const file of files) {
    await execFileAsync('node', ['--check', file], { windowsHide: true });
  }
});

await check('Cron 表达式边界校验', async () => {
  for (const expression of [
    '*/5 * * * *',
    '0 8 * * *',
    '0 9 * * 1-5',
    '15 3 1 * *',
    '0,30 8-20/2 * * 1-6'
  ]) {
    assertValidCronExpression(expression);
  }

  for (const expression of [
    '',
    '/5 * * * *',
    '* * * *',
    '0 24 * * *',
    '0 8 0 * *',
    '0 8 * 13 *',
    '0 8 * * 7',
    '0 8 * * */0',
    '0 8 * * 1//2'
  ]) {
    assertThrows(() => assertValidCronExpression(expression), `应拒绝无效 Cron: ${expression}`);
  }
});

await check('任务定时规则统一校验', async () => {
  assertValidTaskSchedules({
    cronExpression: '@once',
    extraSchedules: []
  });
  assertValidTaskSchedules({
    cronExpression: '@boot',
    extraSchedules: ['0 8 * * *']
  });
  assertValidTaskSchedules({
    cronExpression: '*/10 * * * *',
    extraSchedules: ['0 8 * * 1-5', '30 20 * * *']
  });
  assertThrows(() => assertValidTaskSchedules({ cronExpression: '@daily' }), '应拒绝未知特殊 Cron');
  assertThrows(() => assertValidTaskSchedules({ cronExpression: '*/5 * * * *', extraSchedules: ['@boot'] }), '额外定时规则不应支持特殊 Cron');
  assertThrows(() => assertValidTaskSchedules({ cronExpression: '*/5 * * * *', extraSchedules: ['/5 * * * *'] }), '应拒绝无效额外定时规则');
  assertThrows(() => assertValidTaskSchedules({ cronExpression: '*/5 * * * *', extraSchedules: '0 8 * * *' }), '额外定时规则必须保持数组错误');
});

await check('调度器会执行额外定时规则且同一分钟不重复触发', async () => {
  const fired = [];
  const task = Task.create({
    name: 'extra-schedule-task',
    scriptPath: 'data/scripts/extra.js',
    cronExpression: '0 0 1 1 *',
    extraSchedules: ['30 8 * * *']
  });
  const scheduler = new TaskScheduler({
    taskRepository: { list: async () => [task] },
    commandBus: {
      execute: async (command) => {
        fired.push(command.payload.taskId);
      }
    }
  });

  await scheduler.tick(new Date(2026, 5, 13, 8, 30, 0));
  await scheduler.tick(new Date(2026, 5, 13, 8, 30, 30));
  await scheduler.tick(new Date(2026, 5, 13, 8, 31, 0));
  assert(fired.length === 1, `额外定时规则触发次数异常: ${fired.length}`);
  assert(fired[0] === task.id, '额外定时规则触发了错误任务');
});

await check('任务创建和更新会校验主 Cron 与额外 Cron', async () => {
  const portableRoot = await mkdtemp(path.join(tmpdir(), 'scriptpilot-quality-'));
  try {
    const app = await createApp({ portableRoot });
    const created = await app.commandBus.execute(createTaskCommand({
      name: 'quality-task',
      scriptContent: 'console.log("quality ok");',
      cronExpression: '*/5 * * * *',
      extraSchedules: ['0 8 * * *'],
      cwd: 'data',
      timeoutMs: 30000
    }));
    assert(created.data.taskId, '任务创建未返回 taskId');

    await app.commandBus.execute(updateTaskCommand({
      taskId: created.data.taskId,
      name: 'quality-task-updated',
      scriptPath: 'data/scripts/tasks/quality-updated.js',
      scriptContent: 'console.log("quality updated");',
      cronExpression: '0 9 * * 1-5',
      extraSchedules: ['30 18 * * *'],
      cwd: 'data',
      timeoutMs: 30000
    }));

    const list = await app.queryBus.execute(listTasksQuery());
    assert(list.items.some((item) => item.name === 'quality-task-updated' && item.extraSchedules.includes('30 18 * * *')), '任务更新未保存额外定时规则');

    await assertRejects(
      () => app.commandBus.execute(createTaskCommand({
        name: 'bad-extra',
        scriptContent: 'console.log("bad");',
        cronExpression: '*/5 * * * *',
        extraSchedules: ['/5 * * * *'],
        cwd: 'data'
      })),
      '无效额外定时规则不应创建成功'
    );
  } finally {
    await rm(portableRoot, { recursive: true, force: true });
  }
});

await check('接口直接运行脚本会拒绝无效输入', async () => {
  const portableRoot = await mkdtemp(path.join(tmpdir(), 'scriptpilot-run-validation-'));
  try {
    const app = await createApp({ portableRoot });
    await assertRejects(
      () => app.commandBus.execute(runScriptOnceCommand({
        name: 'bad-timeout',
        scriptContent: 'console.log("should not run");',
        timeoutMs: -1
      })),
      '直接运行脚本不应接受负超时时间'
    );
    await assertRejects(
      () => app.commandBus.execute(runScriptOnceCommand({
        name: 'bad-script-content',
        scriptContent: { code: 'console.log(1)' }
      })),
      '直接运行脚本不应接受非字符串脚本内容'
    );
    await assertRejects(
      () => app.commandBus.execute(runScriptOnceCommand({
        name: 'bad-cwd',
        scriptContent: 'console.log("bad cwd");',
        cwd: ['data']
      })),
      '直接运行脚本不应接受非字符串工作目录'
    );
  } finally {
    await rm(portableRoot, { recursive: true, force: true });
  }
});

await check('定时任务排序设置会拒绝已取消的列', async () => {
  const portableRoot = await mkdtemp(path.join(tmpdir(), 'scriptpilot-settings-'));
  try {
    const repository = new JsonSettingsRepository(path.join(portableRoot, 'data', 'state', 'settings.json'));
    const saved = await repository.save({
      crontab: {
        sort: {
          field: 'scriptPath',
          direction: 'ASC'
        }
      }
    });
    assert(saved.crontab.sort.field === 'pinned', `排序字段未回退: ${saved.crontab.sort.field}`);
    assert(saved.crontab.sort.direction === 'ASC', '合法排序方向应保留');
  } finally {
    await rm(portableRoot, { recursive: true, force: true });
  }
});

await check('GitHub 加速地址归一化且默认不强制加速', async () => {
  assert(normalizeAcceleratorBaseUrl('ghfast.top') === 'https://ghfast.top/', '应补全加速地址协议和斜杠');
  assert(normalizeAcceleratorBaseUrl('') === '', '空加速地址应保持为空');
  const githubUrl = 'https://github.com/Aerozb/ScriptPilot/releases/download/v0.1.5/ScriptPilot-v0.1.5-portable.zip';
  assert(createAcceleratedUrl(githubUrl, '') === githubUrl, '默认空配置不应加速');
  assert(createAcceleratedUrl(githubUrl, 'https://ghfast.top/') === `https://ghfast.top/${githubUrl}`, '应拼接 GitHub 加速地址');
  assert(createUpdateDownloadUrl(githubUrl) === `https://ghfast.top/${githubUrl}`, '更新下载必须使用 ghfast 加速');
});

await check('更新检查会识别新版并选择便携包', async () => {
  assert(compareVersions('0.1.10', '0.1.9') > 0, '版本比较应按数字比较');
  assert(compareVersions('v0.2.0', '0.1.99') > 0, '版本比较应忽略 v 前缀');
  const result = await checkGitHubReleaseUpdate({
    currentVersion: '0.1.5',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v0.1.6',
        name: 'ScriptPilot v0.1.6',
        body: '中文更新说明',
        html_url: 'https://github.com/Aerozb/ScriptPilot/releases/tag/v0.1.6',
        published_at: '2026-06-13T00:00:00Z',
        assets: [
          {
            name: 'ScriptPilot-v0.1.6-portable.zip',
            browser_download_url: 'https://github.com/Aerozb/ScriptPilot/releases/download/v0.1.6/ScriptPilot-v0.1.6-portable.zip'
          }
        ]
      })
    })
  });
  assert(result.hasUpdate, '应识别有新版');
  assert(result.assetName === 'ScriptPilot-v0.1.6-portable.zip', '应选择便携 zip');
  assert(result.acceleratedDownloadUrl.startsWith('https://ghfast.top/https://github.com/'), '更新下载链接应使用 ghfast');
});

await check('网络设置保存 GitHub 加速地址且可清空', async () => {
  const portableRoot = await mkdtemp(path.join(tmpdir(), 'scriptpilot-network-settings-'));
  try {
    const repository = new JsonSettingsRepository(path.join(portableRoot, 'data', 'state', 'settings.json'));
    const saved = await repository.save({
      network: {
        githubAcceleratorBaseUrl: 'ghfast.top'
      }
    });
    assert(saved.network.githubAcceleratorBaseUrl === 'https://ghfast.top/', `加速地址未归一化: ${saved.network.githubAcceleratorBaseUrl}`);
    const cleared = await repository.save({
      network: {
        githubAcceleratorBaseUrl: ''
      }
    });
    assert(cleared.network.githubAcceleratorBaseUrl === '', '加速地址应支持清空');
  } finally {
    await rm(portableRoot, { recursive: true, force: true });
  }
});

await check('本机接口端口占用会返回可处理错误', async () => {
  const occupied = http.createServer((_request, response) => {
    response.end('occupied');
  });
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const port = occupied.address().port;
  try {
    await assertRejects(
      () => startApiServer({}, { port }),
      '端口占用时接口启动不应成功'
    );
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
if (failed.length) process.exitCode = 1;

async function check(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    checks.push({ name, ok: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    checks.push({ name, ok: false, durationMs: Date.now() - startedAt, error: error.stack || error.message });
  }
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertThrows(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

async function assertRejects(fn, message) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

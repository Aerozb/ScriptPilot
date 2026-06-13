import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/main/app/create-app.js';
import { createTaskCommand } from '../src/main/modules/tasks/application/commands/create-task.command.js';
import { updateTaskCommand } from '../src/main/modules/tasks/application/commands/update-task.command.js';
import { listTasksQuery } from '../src/main/modules/tasks/application/queries/list-tasks.query.js';
import { Task } from '../src/main/modules/tasks/domain/task.aggregate.js';
import { TaskScheduler } from '../src/main/modules/scheduler/infrastructure/task-scheduler.js';
import { assertValidCronExpression } from '../src/main/modules/scheduler/infrastructure/cron-expression.js';
import { assertValidTaskSchedules } from '../src/main/modules/tasks/application/task-schedule-validation.js';
import { JsonSettingsRepository } from '../src/main/modules/settings/infrastructure/json-settings-repository.js';

const execFileAsync = promisify(execFile);
const checks = [];

await check('JS 语法检查覆盖关键入口', async () => {
  const files = [
    'src/electron/renderer/renderer.js',
    'src/electron/main.js',
    'src/electron/preload.cjs',
    'src/electron/api-server.js',
    'src/main/modules/scheduler/infrastructure/cron-expression.js',
    'src/main/modules/scheduler/infrastructure/task-scheduler.js',
    'src/main/modules/tasks/application/task-schedule-validation.js',
    'src/main/modules/tasks/application/commands/create-task.handler.js',
    'src/main/modules/tasks/application/commands/update-task.handler.js',
    'src/main/modules/settings/infrastructure/json-settings-repository.js',
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

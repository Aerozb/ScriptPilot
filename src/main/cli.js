#!/usr/bin/env node
import { createApp } from './app/create-app.js';
import { ensureDemoTaskAndRun } from './app/demo-runner.js';
import { listTasksQuery } from './modules/tasks/application/queries/list-tasks.query.js';
import { runTaskNowCommand } from './modules/runs/application/commands/run-task-now.command.js';
import { listRunsQuery } from './modules/runs/application/queries/list-runs.query.js';
import { getRunQuery } from './modules/runs/application/queries/get-run.query.js';
import { getRunLogQuery } from './modules/runs/application/queries/get-run-log.query.js';
import { toAppError } from './shared/errors/app-error.js';

async function main() {
  const app = await createApp();
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'demo') {
    await runDemo(app);
    return;
  }

  if (command === 'list-tasks') {
    const result = await app.queryBus.execute(listTasksQuery());
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'list-runs') {
    const result = await app.queryBus.execute(listRunsQuery({ limit: Number(args[0]) || 20 }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'run-task') {
    const taskId = args[0];
    if (!taskId) {
      throw new Error('用法: node src/main/cli.js run-task <任务ID>');
    }

    const commandResult = await app.commandBus.execute(runTaskNowCommand({ taskId }));
    const run = await app.queryBus.execute(getRunQuery({ runId: commandResult.data.runId }));
    const log = await app.queryBus.execute(getRunLogQuery({ runId: run.id, stream: 'combined' }));
    console.log(JSON.stringify({ run, log }, null, 2));
    process.exitCode = run.status === 'success' ? 0 : 1;
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

async function runDemo(app) {
  const result = await ensureDemoTaskAndRun(app, 'scriptpilot-demo');
  console.log(JSON.stringify(result.summary, null, 2));
  console.log('--- combined log ---');
  console.log(result.log.text.trimEnd());

  process.exitCode = result.run.status === 'success' ? 0 : 1;
}

function printHelp() {
  console.log([
    'ScriptPilot 命令行工具',
    '',
    '命令:',
    '  demo                  创建并运行示例任务',
    '  list-tasks            输出已保存任务',
    '  list-runs [数量]      输出最近运行记录',
    '  run-task <任务ID>     立即运行已有任务'
  ].join('\n'));
}

main().catch((error) => {
  const appError = toAppError(error);
  console.error(JSON.stringify(appError.toPayload(), null, 2));
  process.exitCode = 1;
});

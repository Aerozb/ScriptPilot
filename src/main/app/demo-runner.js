import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTaskCommand } from '../modules/tasks/application/commands/create-task.command.js';
import { listTasksQuery } from '../modules/tasks/application/queries/list-tasks.query.js';
import { runTaskNowCommand } from '../modules/runs/application/commands/run-task-now.command.js';
import { getRunQuery } from '../modules/runs/application/queries/get-run.query.js';
import { getRunLogQuery } from '../modules/runs/application/queries/get-run-log.query.js';

export async function ensureDemoTaskAndRun(app, source = 'scriptpilot-demo') {
  const scriptRelativePath = 'data/scripts/demo-success.js';
  const scriptAbsolutePath = path.join(app.paths.portableRoot, scriptRelativePath);
  await ensureDemoScript(scriptAbsolutePath);

  const taskName = 'demo-success';
  const existingTasks = await app.queryBus.execute(listTasksQuery());
  let task = existingTasks.items.find((item) => item.name === taskName);

  if (!task) {
    const createResult = await app.commandBus.execute(createTaskCommand({
      name: taskName,
      scriptPath: scriptRelativePath,
      cwd: 'data',
      args: ['--from', source],
      enabled: true,
      timeoutMs: 30000
    }));

    const updatedTasks = await app.queryBus.execute(listTasksQuery());
    task = updatedTasks.items.find((item) => item.id === createResult.data.taskId);
  }

  const runResult = await app.commandBus.execute(runTaskNowCommand({ taskId: task.id }));
  const run = await app.queryBus.execute(getRunQuery({ runId: runResult.data.runId }));
  const log = await app.queryBus.execute(getRunLogQuery({ runId: run.id, stream: 'combined' }));

  return {
    task,
    run,
    log,
    summary: {
      taskId: task.id,
      runId: run.id,
      status: run.status,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      stdoutPath: run.stdoutPath,
      stderrPath: run.stderrPath,
      runtime: run.runtime
    }
  };
}

export async function ensureDemoScript(scriptPath) {
  await mkdir(path.dirname(scriptPath), { recursive: true });
  const source = [
    "const result = {",
    "  message: 'ScriptPilot demo script executed successfully',",
    "  cwd: process.cwd(),",
    "  args: process.argv.slice(2),",
    "  taskId: process.env.SCRIPTPILOT_TASK_ID,",
    "  runId: process.env.SCRIPTPILOT_RUN_ID",
    "};",
    "console.log(JSON.stringify(result, null, 2));",
    ''
  ].join('\n');
  await writeFile(scriptPath, source, 'utf8');
}

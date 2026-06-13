import { createPortablePaths, ensurePortableDirectories } from '../bootstrap/portable-paths.js';
import { CommandBus } from '../shared/application/command-bus.js';
import { QueryBus } from '../shared/application/query-bus.js';
import { runNodeScript, stopRunningNodeScript } from '../shared/infrastructure/process/process-runner.js';
import { resolveNodeRuntime } from '../modules/runtime/infrastructure/node-runtime-resolver.js';
import { JsonTaskRepository } from '../modules/tasks/infrastructure/json-task-repository.js';
import { CreateTaskHandler } from '../modules/tasks/application/commands/create-task.handler.js';
import { CREATE_TASK_COMMAND } from '../modules/tasks/application/commands/create-task.command.js';
import { DELETE_TASK_COMMAND } from '../modules/tasks/application/commands/delete-task.command.js';
import { DeleteTaskHandler } from '../modules/tasks/application/commands/delete-task.handler.js';
import { SET_TASK_ENABLED_COMMAND } from '../modules/tasks/application/commands/set-task-enabled.command.js';
import { SetTaskEnabledHandler } from '../modules/tasks/application/commands/set-task-enabled.handler.js';
import { SET_TASKS_ENABLED_COMMAND } from '../modules/tasks/application/commands/set-tasks-enabled.command.js';
import { SetTasksEnabledHandler } from '../modules/tasks/application/commands/set-tasks-enabled.handler.js';
import { UPDATE_TASK_COMMAND } from '../modules/tasks/application/commands/update-task.command.js';
import { UpdateTaskHandler } from '../modules/tasks/application/commands/update-task.handler.js';
import { SET_TASK_PINNED_COMMAND } from '../modules/tasks/application/commands/set-task-pinned.command.js';
import { SetTaskPinnedHandler } from '../modules/tasks/application/commands/set-task-pinned.handler.js';
import { SET_TASKS_PINNED_COMMAND } from '../modules/tasks/application/commands/set-tasks-pinned.command.js';
import { SetTasksPinnedHandler } from '../modules/tasks/application/commands/set-tasks-pinned.handler.js';
import { UPDATE_TASK_LABELS_COMMAND } from '../modules/tasks/application/commands/update-task-labels.command.js';
import { UpdateTaskLabelsHandler } from '../modules/tasks/application/commands/update-task-labels.handler.js';
import { LIST_TASKS_QUERY } from '../modules/tasks/application/queries/list-tasks.query.js';
import { ListTasksHandler } from '../modules/tasks/application/queries/list-tasks.handler.js';
import { JsonRunRepository } from '../modules/runs/infrastructure/json-run-repository.js';
import { RUN_TASK_NOW_COMMAND } from '../modules/runs/application/commands/run-task-now.command.js';
import { RunTaskNowHandler } from '../modules/runs/application/commands/run-task-now.handler.js';
import { LIST_RUNS_QUERY } from '../modules/runs/application/queries/list-runs.query.js';
import { ListRunsHandler } from '../modules/runs/application/queries/list-runs.handler.js';
import { GET_RUN_QUERY } from '../modules/runs/application/queries/get-run.query.js';
import { GetRunHandler } from '../modules/runs/application/queries/get-run.handler.js';
import { GET_RUN_LOG_QUERY } from '../modules/runs/application/queries/get-run-log.query.js';
import { GetRunLogHandler } from '../modules/runs/application/queries/get-run-log.handler.js';
import { RUN_SCRIPT_ONCE_COMMAND } from '../modules/runs/application/commands/run-script-once.command.js';
import { RunScriptOnceHandler } from '../modules/runs/application/commands/run-script-once.handler.js';
import { STOP_TASK_RUN_COMMAND } from '../modules/runs/application/commands/stop-task-run.command.js';
import { StopTaskRunHandler } from '../modules/runs/application/commands/stop-task-run.handler.js';
import { ensureScriptDependencies } from '../modules/dependencies/infrastructure/script-dependency-manager.js';
import { TaskScheduler } from '../modules/scheduler/infrastructure/task-scheduler.js';
import { JsonSettingsRepository } from '../modules/settings/infrastructure/json-settings-repository.js';
import { LocalWorkspaceService } from '../modules/workspace/infrastructure/local-workspace-service.js';
import { LogCleanupService } from '../modules/logs/infrastructure/log-cleanup-service.js';

export async function createApp(options = {}) {
  const paths = createPortablePaths(options.portableRoot);
  await ensurePortableDirectories(paths);

  const taskRepository = new JsonTaskRepository(paths.tasksJson);
  const runRepository = new JsonRunRepository(paths.runsJson);
  const settingsRepository = new JsonSettingsRepository(paths.settingsJson);
  const workspaceService = new LocalWorkspaceService(paths, {
    runRepository,
    taskRepository,
    settingsRepository
  });
  const logCleanupService = new LogCleanupService({
    paths,
    runRepository,
    settingsRepository
  });
  const commandBus = new CommandBus();
  const queryBus = new QueryBus();

  commandBus.register(CREATE_TASK_COMMAND, new CreateTaskHandler({
    paths,
    taskRepository
  }));
  commandBus.register(UPDATE_TASK_COMMAND, new UpdateTaskHandler({
    paths,
    taskRepository
  }));
  commandBus.register(SET_TASK_ENABLED_COMMAND, new SetTaskEnabledHandler(taskRepository));
  commandBus.register(SET_TASKS_ENABLED_COMMAND, new SetTasksEnabledHandler(taskRepository));
  commandBus.register(SET_TASK_PINNED_COMMAND, new SetTaskPinnedHandler(taskRepository));
  commandBus.register(SET_TASKS_PINNED_COMMAND, new SetTasksPinnedHandler(taskRepository));
  commandBus.register(UPDATE_TASK_LABELS_COMMAND, new UpdateTaskLabelsHandler(taskRepository));
  commandBus.register(DELETE_TASK_COMMAND, new DeleteTaskHandler(taskRepository));
  commandBus.register(RUN_TASK_NOW_COMMAND, new RunTaskNowHandler({
    paths,
    taskRepository,
    runRepository,
    resolveNodeRuntime,
    runNodeScript,
    ensureScriptDependencies,
    stopRunningNodeScript
  }));
  commandBus.register(RUN_SCRIPT_ONCE_COMMAND, new RunScriptOnceHandler({
    paths,
    runRepository,
    resolveNodeRuntime,
    runNodeScript,
    ensureScriptDependencies
  }));
  commandBus.register(STOP_TASK_RUN_COMMAND, new StopTaskRunHandler({
    runRepository,
    stopRunningNodeScript
  }));

  queryBus.register(LIST_TASKS_QUERY, new ListTasksHandler(taskRepository));
  queryBus.register(LIST_RUNS_QUERY, new ListRunsHandler(runRepository));
  queryBus.register(GET_RUN_QUERY, new GetRunHandler(runRepository));
  queryBus.register(GET_RUN_LOG_QUERY, new GetRunLogHandler(paths, runRepository));

  const scheduler = new TaskScheduler({
    taskRepository,
    commandBus
  });

  return {
    paths,
    commandBus,
    queryBus,
    scheduler,
    repositories: {
      taskRepository,
      runRepository,
      settingsRepository
    },
    services: {
      workspaceService,
      logCleanupService
    }
  };
}

export const STOP_TASK_RUN_COMMAND = 'runs.stopTaskRun';

export function stopTaskRunCommand(input) {
  return {
    type: STOP_TASK_RUN_COMMAND,
    payload: input
  };
}

export const RUN_TASK_NOW_COMMAND = 'runs.runTaskNow';

export function runTaskNowCommand(input) {
  return {
    type: RUN_TASK_NOW_COMMAND,
    payload: input
  };
}

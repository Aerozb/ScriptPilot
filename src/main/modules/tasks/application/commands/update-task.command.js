export const UPDATE_TASK_COMMAND = 'tasks.update';

export function updateTaskCommand(input) {
  return {
    type: UPDATE_TASK_COMMAND,
    payload: input
  };
}

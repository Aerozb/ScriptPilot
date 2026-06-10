export const DELETE_TASK_COMMAND = 'tasks.delete';

export function deleteTaskCommand(input) {
  return {
    type: DELETE_TASK_COMMAND,
    payload: input
  };
}

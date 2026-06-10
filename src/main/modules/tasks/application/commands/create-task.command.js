export const CREATE_TASK_COMMAND = 'tasks.create';

export function createTaskCommand(input) {
  return {
    type: CREATE_TASK_COMMAND,
    payload: input
  };
}

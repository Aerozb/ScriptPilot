export const SET_TASK_ENABLED_COMMAND = 'tasks.setEnabled';

export function setTaskEnabledCommand(input) {
  return {
    type: SET_TASK_ENABLED_COMMAND,
    payload: input
  };
}

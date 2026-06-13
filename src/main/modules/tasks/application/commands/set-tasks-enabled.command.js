export const SET_TASKS_ENABLED_COMMAND = 'tasks.setManyEnabled';

export function setTasksEnabledCommand(input) {
  return {
    type: SET_TASKS_ENABLED_COMMAND,
    payload: input
  };
}

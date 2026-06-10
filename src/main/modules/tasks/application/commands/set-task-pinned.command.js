export const SET_TASK_PINNED_COMMAND = 'tasks.setPinned';

export function setTaskPinnedCommand(input) {
  return {
    type: SET_TASK_PINNED_COMMAND,
    payload: input
  };
}

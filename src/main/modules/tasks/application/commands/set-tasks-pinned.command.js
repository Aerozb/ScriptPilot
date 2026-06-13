export const SET_TASKS_PINNED_COMMAND = 'tasks.setManyPinned';

export function setTasksPinnedCommand(input) {
  return {
    type: SET_TASKS_PINNED_COMMAND,
    payload: input
  };
}

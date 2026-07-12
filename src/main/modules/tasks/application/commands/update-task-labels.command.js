export const UPDATE_TASK_LABELS_COMMAND = 'tasks.updateLabels';

export function updateTaskLabelsCommand(input) {
  return {
    type: UPDATE_TASK_LABELS_COMMAND,
    payload: input
  };
}

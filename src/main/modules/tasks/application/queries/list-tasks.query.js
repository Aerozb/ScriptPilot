export const LIST_TASKS_QUERY = 'tasks.list';

export function listTasksQuery(input = {}) {
  return {
    type: LIST_TASKS_QUERY,
    payload: input
  };
}

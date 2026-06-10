export const LIST_RUNS_QUERY = 'runs.list';

export function listRunsQuery(input = {}) {
  return {
    type: LIST_RUNS_QUERY,
    payload: input
  };
}

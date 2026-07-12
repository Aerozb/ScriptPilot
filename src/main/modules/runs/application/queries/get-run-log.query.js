export const GET_RUN_LOG_QUERY = 'runs.getLog';

export function getRunLogQuery(input) {
  return {
    type: GET_RUN_LOG_QUERY,
    payload: input
  };
}

export const GET_RUN_QUERY = 'runs.get';

export function getRunQuery(input) {
  return {
    type: GET_RUN_QUERY,
    payload: input
  };
}

export const RUN_SCRIPT_ONCE_COMMAND = 'runs.runScriptOnce';

export function runScriptOnceCommand(input) {
  return {
    type: RUN_SCRIPT_ONCE_COMMAND,
    payload: input
  };
}

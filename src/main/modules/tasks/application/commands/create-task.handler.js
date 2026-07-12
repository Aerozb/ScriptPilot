import { commandOk } from '../../../../shared/application/command-result.js';
import { assertValidCronExpression } from '../../../scheduler/infrastructure/cron-expression.js';
import { normalizeTaskPaths, writeTaskScript } from '../../infrastructure/task-script-writer.js';
import { Task } from '../../domain/task.aggregate.js';

export class CreateTaskHandler {
  constructor(deps) {
    this.paths = deps.paths;
    this.taskRepository = deps.taskRepository;
  }

  async handle(command) {
    const input = { ...command.payload };
    if (input.scriptContent) {
      input.scriptPath = await writeTaskScript(this.paths, input);
    }

    normalizeTaskPaths(this.paths, input);

    if (input.cronExpression && !String(input.cronExpression).startsWith('@')) {
      assertValidCronExpression(input.cronExpression);
    }

    const task = Task.create(input);
    await this.taskRepository.save(task);
    return commandOk({ taskId: task.id });
  }
}

import { AppError } from '../../../../shared/errors/app-error.js';

export class GetRunHandler {
  constructor(runRepository) {
    this.runRepository = runRepository;
  }

  async handle(query) {
    const run = await this.runRepository.findById(query.payload.runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `运行记录不存在: ${query.payload.runId}`);
    }

    return run.toRecord();
  }
}

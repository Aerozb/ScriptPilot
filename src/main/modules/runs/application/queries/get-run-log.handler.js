import { readFile } from 'node:fs/promises';
import { AppError } from '../../../../shared/errors/app-error.js';
import { resolvePortablePath } from '../../../../bootstrap/portable-paths.js';

export class GetRunLogHandler {
  constructor(paths, runRepository) {
    this.paths = paths;
    this.runRepository = runRepository;
  }

  async handle(query) {
    const run = await this.runRepository.findById(query.payload.runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `运行记录不存在: ${query.payload.runId}`);
    }

    const stream = query.payload.stream || 'combined';
    const stdoutText = stream !== 'stderr' ? await readOptional(resolvePortablePath(this.paths, run.stdoutPath)) : '';
    const stderrText = stream !== 'stdout' ? await readOptional(resolvePortablePath(this.paths, run.stderrPath)) : '';

    return {
      runId: run.id,
      stream,
      text: stream === 'stdout' ? stdoutText : stream === 'stderr' ? stderrText : `${stdoutText}${stderrText}`
    };
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

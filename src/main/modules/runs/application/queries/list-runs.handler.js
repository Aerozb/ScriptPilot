export class ListRunsHandler {
  constructor(runRepository) {
    this.runRepository = runRepository;
  }

  async handle(query) {
    const limit = query.payload.limit || 50;
    const runs = await this.runRepository.list();
    const sorted = runs.toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    return {
      items: sorted.slice(0, limit).map((run) => run.toRecord())
    };
  }
}

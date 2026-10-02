export class RepositoryOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RepositoryOperationError"; }
}

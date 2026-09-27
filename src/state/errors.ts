// state/ が投げる例外。api/ はこれを見て 404 にする（HttpError には依存しない）。
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

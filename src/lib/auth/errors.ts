export class AuthorizationError extends Error {
  readonly status: number;
  constructor(message = 'אין הרשאה', status = 403) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
  }
}

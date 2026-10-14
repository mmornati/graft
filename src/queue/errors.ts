/**
 * Thrown by a job when retrying cannot help (deleted PR, lost permission, bad payload). The
 * worker logs it and completes the job instead of failing it.
 */
export class PermanentJobError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

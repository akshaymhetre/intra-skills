/** An expected failure: printed as a one-line message, never with a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    public code: string = "error",
    public exitCode: number = 1,
    public details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Bad invocation: exit code 2. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, "usage", 2);
    this.name = "UsageError";
  }
}

/** A non-2xx answer from the registry, or a registry that could not be reached (status 0). */
export class ApiError extends CliError {
  constructor(
    code: string,
    message: string,
    public status: number,
    details?: unknown,
  ) {
    super(message, code, 1, details);
    this.name = "ApiError";
  }
  get offline(): boolean {
    return this.status === 0;
  }
}

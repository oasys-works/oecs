// Shared base error for the package. The ECS-specific error vocabulary
// (`ECSError` + the `ECS_ERROR` category enum) lives next to the core it
// belongs to, in `core/ecs/utils/error.ts`, and extends this class.
export abstract class AppError extends Error {
  constructor(
    message: string,
    public readonly isOperational: boolean,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

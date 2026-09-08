// Shared base error for the package. The ECS-specific error vocabulary
// (`ECSError` + the `ECS_ERROR` category enum) lives next to the core it
// belongs to, in `core/ecs/utils/error.ts`, and extends this class.
export abstract class AppError extends Error {
	constructor(
		message: string,
		public readonly isOperational: boolean,
		public readonly context?: Record<string, unknown>
	) {
		super(message);
		// A subclass overwrites this with a literal. A production build renames
		// the class, so the constructor name is one minified letter there.
		this.name = this.constructor.name;
		// A V8 extension. JavaScriptCore and SpiderMonkey gained it late, and an
		// engine without it must still deliver the fault and its category.
		if (typeof Error.captureStackTrace === "function") {
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

// ============================ CONSTANTS ============================

const LOG = {
	CAPACITY: 256
} as const;

// ============================ TYPES ============================

export enum LOG_CATEGORY {
	ECS = "ECS"
}

export interface LogEntry {
	readonly timestamp: number;
	readonly wallTime: number;
	readonly category: LOG_CATEGORY;
	readonly message: string;
}

/** Notified with each new entry as it is logged. */
export type LogSink = (entry: LogEntry) => void;

// ============================ LOGGER ============================

class Logger {
	private _entries: LogEntry[] = [];
	private _capacity: number;
	private readonly _sinks: Set<LogSink> = new Set();

	public constructor(capacity: number = LOG.CAPACITY) {
		this._capacity = capacity;
	}

	public get capacity(): number {
		return this._capacity;
	}

	public setCapacity(value: number): void {
		this._capacity = value;
		while (this._entries.length > this._capacity) {
			this._entries.shift();
		}
	}

	public get entries(): readonly LogEntry[] {
		return this._entries.slice();
	}

	public log(category: LOG_CATEGORY, message: string): void {
		const entry: LogEntry = {
			timestamp: performance.now(),
			wallTime: Date.now(),
			category,
			message
		};
		this._entries.push(entry);

		if (this._entries.length > this._capacity) {
			this._entries.shift();
		}

		for (const sink of this._sinks) {
			sink(entry);
		}
	}

	public clear(): void {
		this._entries = [];
	}

	/** Register a sink notified on every subsequent `log()`. Returns an unsubscribe fn. */
	public subscribe(sink: LogSink): () => void {
		this._sinks.add(sink);
		return () => {
			this._sinks.delete(sink);
		};
	}
}

// ============================ SINGLETON ============================

export const logger = new Logger();

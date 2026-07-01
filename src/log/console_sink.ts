import type { LogEntry, LogSink } from "./logger";

/** A LogSink that writes each entry to stdout — for headless hosts (e.g. the server). */
export const consoleSink: LogSink = (entry: LogEntry): void => {
	console.log(`[${entry.category}] ${entry.message}`);
};

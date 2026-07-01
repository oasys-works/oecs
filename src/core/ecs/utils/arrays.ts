/***
 * Array utilities — helpers for hash-bucketed maps.
 *
 ***/

/** Push a value into a hash-bucket map, creating the bucket array if absent. */
export function bucketPush<T>(map: Map<number, T[]>, key: number, value: T): void {
	const bucket = map.get(key);
	if (bucket !== undefined) {
		bucket.push(value);
	} else {
		map.set(key, [value]);
	}
}

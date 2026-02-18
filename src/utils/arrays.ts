/**
 * Grow a number[] to hold at least `min_capacity` elements.
 * Doubles from the current length until sufficient, fills new slots
 * with `fill`, and copies existing data into the new buffer.
 */
export function grow_number_array(
  arr: number[],
  min_capacity: number,
  fill: number,
): number[] {
  let cap = arr.length;
  while (cap < min_capacity) cap *= 2;
  const next = new Array(cap).fill(fill);
  for (let i = 0; i < arr.length; i++) next[i] = arr[i];
  return next;
}

/**
 * Push `value` into a hash-bucket map, creating the bucket if absent.
 */
export function bucket_push<T>(
  map: Map<number, T[]>,
  key: number,
  value: T,
): void {
  const bucket = map.get(key);
  if (bucket !== undefined) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
}

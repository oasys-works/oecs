/**
 * StoreLayoutListener — receives notifications when the engine publishes
 * a new SAB layout. The engine calls `setLayout(headerOff)`:
 *
 *   1. immediately when the listener subscribes (seeds the initial
 *      layout), and
 *   2. after every SAB grow / extend (the `view_stamp` republish
 *      protocol).
 *
 * Any consumer that caches column byte_offs off the layout descriptor
 * MUST invalidate on this call.
 *
 * The interface deliberately has nothing consumer-specific. The engine
 * publishes layouts to whoever subscribes; the consumer owns its own
 * typed wrapper (a compute backend, a Worker proxy, a debug recorder) and
 * drives it from its own code — none of that surface appears on the engine.
 * A `ComputeBackend` extends this interface, so attaching a backend
 * subscribes it to layout republishes for free; see `compute_backend.ts`.
 */
export interface StoreLayoutListener {
	setLayout(headerOff: number): void;
}

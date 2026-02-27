# Queries

## Creating Queries

`world.query()` returns a cached, live view over all archetypes matching the given components.

```ts
const q = world.query(Pos, Vel);
```

Queries are live -- as new archetypes are created, matching ones are automatically added to the query's result set. Component order doesn't matter: `query(Pos, Vel)` and `query(Vel, Pos)` produce the same result.

## Iterating with `for..of`

Use `for..of` to iterate non-empty matching archetypes. Access columns via `get_column()` (returns typed arrays like `Float64Array`, `Int32Array`, etc.), then write the inner loop over `arch.entity_count`.

```ts
for (const arch of q) {
  const px = arch.get_column(Pos, "x");   // Float64Array (or whatever the schema specifies)
  const py = arch.get_column(Pos, "y");
  const vx = arch.get_column(Vel, "vx");
  const vy = arch.get_column(Vel, "vy");
  const n = arch.entity_count;
  for (let i = 0; i < n; i++) {
    px[i] += vx[i];
    py[i] += vy[i];
  }
}
```

The iterator skips empty archetypes automatically.

## Query Chaining

Queries compose immutably -- each method returns a new (cached) query.

```ts
// Extend required components
const q = world.query(Position).and(Velocity);

// Exclude archetypes that have a component
const alive = world.query(Position).not(Dead);

// Require at least one of these
const damaged = world.query(Health).any_of(Poison, Fire);

// Combine
const targets = world.query(Position).and(Health).not(Shield).any_of(IsEnemy, IsBoss);
```

## Query Count

```ts
q.count();  // total entity count across all matching archetypes
q.archetype_count;  // number of matching archetypes (including empty ones)
```

## QueryBuilder

Used inside `register_system` to resolve a query once at registration time:

```ts
const moveSys = world.register_system(
  (q, ctx, dt) => {
    for (const arch of q) {
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      const vx = arch.get_column(Vel, "vx");
      const vy = arch.get_column(Vel, "vy");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    }
  },
  (qb) => qb.every(Pos, Vel),
);
```

The query is captured in the closure and reused every frame. For systems that don't need a query, pass a bare function:

```ts
const logSys = world.register_system((ctx, dt) => {
  console.log("frame", dt);
});
```

## Query Caching

Queries with identical masks (include, exclude, any_of) return the same cached instance. The cache uses hash-bucketed deduplication with golden-ratio xor multipliers, with exact `BitSet.equals()` matching within buckets.

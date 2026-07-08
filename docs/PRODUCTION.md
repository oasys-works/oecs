# Development guards & production builds

oecs gates its runtime safety net — ~328 checks: bounds/liveness checks, the
system access checker (`reads`/`writes` enforcement), duplicate-system and
registration validation, structural-during-iteration guards, friendly `ECSError`
messages, and the frame/dispatch tracers — behind a single compile-time flag,
`__DEV__` (exposed as `DEV` in `src/dev_flag.ts`). Every one of these is a
**development tripwire, not a production guarantee**: in a production build the
guards are gone and the same mistake *fails open* — a wrong value, a `NaN`, a raw
`TypeError`, or silent corruption instead of a friendly throw. Fix violations in
development; never rely on them firing in production.

**Production is the default on both channels.** You opt *into* the guards; you
never have to opt out to ship. The scheduler's cycle detection and the
constructor-time validators (timestep, memory options, relation cardinality) are
the exception — they run in every build.

---

## npm consumers

The default import is the **production** build — guards are dead-code-eliminated
by the bundler at our build, so they cost nothing (zero bytes, zero branches).
Nothing to configure to ship.

```ts
import { ECS } from "@oasys/oecs"; // production: guards stripped
```

### Guards during your own development

Most bundlers set the `development`/`production` **export condition** from their
mode, so you get the guards-on build automatically while developing and the
stripped build automatically in your production bundle — no code change:

| Consumer setup | Resolves to |
| --- | --- |
| `vite dev` / `webpack --mode development` | `@oasys/oecs` **development** build (guards on) |
| `vite build` / `webpack --mode production` | `@oasys/oecs` **production** build (guards stripped) |
| plain Node, CDN, or a bundler that sets no condition | **production** build (the `default`) |

### Forcing the guards-on build directly

For a `<script>`/CDN drop-in, a quick debugging session, or a bundler that does
*not* auto-set conditions (raw esbuild/Rollup resolve to `default` = production),
import the development build explicitly:

```ts
import { ECS } from "@oasys/oecs/dev"; // always the guards-on build
```

`@oasys/oecs/dev` is the same public API as `@oasys/oecs`; only the guards differ.

---

## Deno / JSR consumers

JSR ships **raw TypeScript** — there is no bundler and therefore no dead-code
elimination. Dev-vs-prod is a **runtime** decision: the guard code is always
present; `DEV` only gates whether the branches run. The default is production
(`DEV = false`, guards off, no per-frame tax).

To turn the safety net **on** while developing, set the global **before the first
import** of the package:

```ts
globalThis.__DEV__ = true; // MUST run before oecs is first imported
import { ECS } from "@oasys/oecs";
```

Module evaluation is depth-first in import order, so the assignment must sit in an
entry module that is evaluated before any oecs module — typically the very top of
your program's entry file, above the import, or in a tiny side-effect module you
import first. Because there is no bundler, this is a *toggle*, not a strip: even
with `DEV = false` the guard code ships; it simply doesn't execute. That is the
physical limit of a no-bundler runtime, and it costs nothing at steady state
beyond the already-loaded bytes.

> There is deliberately **no `@oasys/oecs/dev` on JSR** — a wrapper subpath cannot
> flip the flag reliably (ESM evaluates the re-exported core modules before the
> wrapper's body runs). Use the `globalThis.__DEV__` opt-in above.

---

## Manual override (any environment)

`dev_flag.ts` checks `typeof __DEV__` first, so a `globalThis.__DEV__` set before
the first import wins over every default — on npm *and* Deno:

```ts
globalThis.__DEV__ = true;  // force guards on  (e.g. reproduce a bug in a prod-mode app)
globalThis.__DEV__ = false; // force guards off
```

On npm this only affects the build you actually loaded: the production build has
already had its guard *bodies* removed, so forcing `__DEV__ = true` there cannot
resurrect them — load `@oasys/oecs/dev` (or build in development mode) if you want
guards on an npm consumer.

---

## Quick reference

| I want… | npm | Deno / JSR |
| --- | --- | --- |
| ship production (default) | `import "@oasys/oecs"` | default — nothing to do |
| guards while developing | auto in dev-mode bundlers, or `import "@oasys/oecs/dev"` | `globalThis.__DEV__ = true` before first import |
| guards physically removed (DCE) | production build (default) | not possible without a bundler — runtime toggle only |

See also: [errors](./api/errors.md) (which `ECSError`s are dev-only vs always-on)
and the [dev-vs-prod note](./api/index.md#dev-vs-prod--read-this-once).

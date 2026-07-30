# Development guards and production builds

oecs puts its run-time safety checks behind one compile-time flag, `__DEV__`, which `src/dev_flag.ts`
exposes as `DEV`. There are about 328 checks:

- the bounds and liveness checks;
- the system access checker, which holds you to `reads` and `writes`;
- the validation of a system that you added two times, and of each registration;
- the guards against a structural change during iteration;
- the `ECSError` messages that a person can read;
- the tracers for the frames and the dispatches.

Each one of these is a **development aid, and not a production guarantee**. In a production build
the guards are absent, and the same mistake *fails without a signal*. You then get an incorrect
value, a `NaN`, a raw `TypeError`, or quiet corruption, and not a clear error. Correct each
violation while you develop. Never depend on a check to occur in production.

**Production is the default on both channels.** You must turn the guards on. You never have to turn
anything off to ship. There is one exception: the cycle detection in the scheduler, and the
validators that run at construction for the timestep, the memory options, and the cardinality of a
relation. Those run in each build.

---

## Consumers on npm

The default import is the **production** build. Our build removes the guards as dead code, so they
cost nothing: zero bytes, and zero branches. You configure nothing to ship.

```ts
import { ECS } from "@oasys/oecs"; // production: the guards are removed
```

### Guards while you develop

Most bundlers set the `development` or `production` **export condition** from their mode. So you
get the build with the guards automatically while you develop, and you get the build with the
guards removed automatically in your production bundle. You change no code:

| Your setup | It resolves to |
| --- | --- |
| `vite dev` / `webpack --mode development` | the **development** build of `@oasys/oecs` (the guards are on) |
| `vite build` / `webpack --mode production` | the **production** build of `@oasys/oecs` (the guards are removed) |
| plain Node, a CDN, or a bundler that sets no condition | the **production** build (the `default`) |

### How to select the build with the guards directly

For a `<script>` tag or a CDN, for a short debugging session, or for a bundler that does *not* set
a condition automatically, import the development build explicitly. Note that raw esbuild and
Rollup resolve to `default`, which is production.

```ts
import { ECS } from "@oasys/oecs/dev"; // always the build with the guards on
```

`@oasys/oecs/dev` has the same public API as `@oasys/oecs`. Only the guards are different.

---

## Consumers on Deno and JSR

JSR gives you **raw TypeScript**. There is no bundler, and so there is no removal of dead code.
The choice between development and production is a decision at **run time**: the guard code is
always present, and `DEV` only controls whether the branches run. The default is production
(`DEV = false`), so the guards are off and there is no cost in each frame.

To turn the safety checks **on** while you develop, set the global variable **before the first
import** of the package:

```ts
globalThis.__DEV__ = true; // this MUST run before the first import of oecs
import { ECS } from "@oasys/oecs";
```

A module evaluates depth first, in import order. So the assignment must be in a module that
evaluates before each module of oecs. Usually that is the top of the entry file of your program,
above the import, or a small module with a side effect that you import first. Because there is no
bundler, this is a switch, and not a removal: with `DEV = false` the guard code is still in the
package, but it does not run. That is the physical limit of a runtime with no bundler, and at a
steady state it costs nothing past the bytes that you already loaded.

> There is deliberately **no `@oasys/oecs/dev` on JSR**. A wrapper subpath cannot change the flag
> reliably, because ESM evaluates the core modules that the wrapper exports again before the body
> of the wrapper runs. Use the `globalThis.__DEV__` option above.

---

## A manual override (in any environment)

`dev_flag.ts` tests `typeof __DEV__` first. So a `globalThis.__DEV__` value that you set before
the first import has priority over each default, on npm **and** on Deno:

```ts
globalThis.__DEV__ = true;  // force the guards on  (for example, to reproduce a bug in an application in production mode)
globalThis.__DEV__ = false; // force the guards off
```

On npm this changes only the build that you loaded. Our build already removed the *bodies* of the
guards from the production build. So a `__DEV__ = true` value there cannot make them return. To
get the guards on npm, load `@oasys/oecs/dev`, or build in development mode.

---

## Quick reference

| I want… | npm | Deno / JSR |
| --- | --- | --- |
| to ship production (the default) | `import "@oasys/oecs"` | the default — do nothing |
| the guards while I develop | automatic in a bundler in development mode, or `import "@oasys/oecs/dev"` | `globalThis.__DEV__ = true` before the first import |
| the guards physically removed | the production build (the default) | not possible without a bundler — the switch is at run time only |

See also: [errors](./api/errors.md), which lists the `ECSError` values that are for development only
and the values that are always active, and the
[note on development and production](./api/index.md#dev-vs-prod--read-this-once).

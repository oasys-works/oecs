/**
 * Shared test helpers for ECS tests under packages/engine/src/core/ecs/__tests__.
 *
 * Phase B of issue #213 made `SystemAccessDeclaration` mandatory on every
 * `registerSystem` config and validates it at runtime in __DEV__. Tests
 * generally don't care about precise access tracking — they just want a
 * system that's allowed to read/write whatever components are in scope.
 *
 * `openAccess(...defs)` builds a permissive declaration for the supplied
 * component handles: every component is in `reads + writes` (so reads,
 * writes, and adds are all allowed since checkAdd consults `writes`) and
 * in `despawns` (so removeComponent / destroyEntity pass).
 *
 * Phase C note: `spawns` and `transitions` are LEFT EMPTY here on purpose.
 * Phase C of issue #213 walks every system's spawns + transitions at
 * `world.startup()` to pre-warm archetypes; populating those fields here
 * would silently plant archetypes ahead of time and break tests that
 * assert pre-flush empty archetype state. Tests that DO want a particular
 * mask pre-warmed should pass an explicit `spawns` override after the
 * spread:
 *
 *   registerSystem({ ...openAccess([Pos, Vel]), spawns: [[Pos, Vel]], fn });
 */

import type { ComponentDef } from "../component";
import type { SparseComponentDef } from "../sparse_store";
import type { RelationDef } from "../relation";
import type { ResourceKey } from "../resource";
import type { SystemAccessDeclaration } from "../system";

/** A permissive access declaration over the supplied components and
 * resources. See file header for why `spawns` / `transitions` are empty.
 *
 * `sparseDefs` / `relationDefs` (#496) are placed in both the read and
 * write terms of their respective (separate) id spaces, so the returned
 * declaration also authorises every sparse/relation op on the supplied
 * handles. Omit them for a dense-only system (the optional terms stay absent,
 * matching the production default). */
export function openAccess(
	defs: readonly ComponentDef[],
	resourceKeys: readonly ResourceKey<unknown>[] = [],
	sparseDefs: readonly SparseComponentDef[] = [],
	relationDefs: readonly RelationDef[] = []
): SystemAccessDeclaration {
	return {
		reads: defs,
		writes: defs,
		spawns: [],
		despawns: defs,
		transitions: [],
		resourceReads: resourceKeys,
		resourceWrites: resourceKeys,
		sparseReads: sparseDefs,
		sparseWrites: sparseDefs,
		relationReads: relationDefs,
		relationWrites: relationDefs
	};
}

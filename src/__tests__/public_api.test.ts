/**
 * Public-API snapshot (M6) — the root entry is a curated, explicit list, and
 * this test makes any widening (or narrowing) of the published runtime
 * surface an explicit diff in review. Type-only exports have no runtime
 * presence and are not covered here; the explicit export lists in
 * `src/index.ts` / `src/internal.ts` are their review surface.
 *
 * If this test fails because you intentionally changed the API: update the
 * list AND treat the change as a semver event (root = stable surface;
 * `/internal` carries no guarantees but the list still documents it).
 */
import { describe, expect, it } from "vitest";
import * as root from "../index";
import * as internal from "../internal";

const ROOT_EXPORTS = [
	"ANY_RELATION",
	"ChangedQuery",
	"ChunkColumns",
	"Commands",
	"ECS",
	"ECSError",
	"ECS_ERROR",
	"FrameTraceRecorder",
	"HIERARCHY_UNBOUNDED",
	"HostCommandQueue",
	"HostCommandRecorder",
	"Query",
	"QueryBuilder",
	"SCHEDULE",
	"SabUnavailableError",
	"SparseRestoreError",
	"StoreRestoreError",
	"SystemContext",
	"VERSION",
	"WORLD_SNAPSHOT_VERSION",
	"WorldRestoreError",
	"allOf",
	"anyOf",
	"applyHostCommand",
	"bundle",
	"deserializeCommandLog",
	"eventKey",
	"getEntityIndex",
	"installHostCommandSeam",
	"isEcsError",
	"not",
	"registerChildOf",
	"registerIsA",
	"replayCommandLog",
	"resourceKey",
	"runEveryNTicks",
	"runIfAnyMatch",
	"runIfResourceEq",
	"serializeCommandLog",
	"signalKey",
	"spawnEntry",
	"systemSet",
	"uninstallHostCommandSeam"
];

const INTERNAL_EXPORTS = [
	"BUDGET_DEFAULT_ARCHETYPES",
	"BUDGET_DEFAULT_BYTES_PER_ENTITY",
	"BUDGET_GROWTH_HEADROOM",
	"DEFAULT_ECS_CAP_BYTES",
	"HOST_COMMAND_PAYLOAD_BYTES",
	"HostCommandDispatcher",
	"MAX_ENTITY_ID",
	"MAX_GENERATION",
	"MAX_INDEX",
	"MAX_LIVE_GENERATION",
	"RETIRED_GENERATION",
	"accessCheck",
	"createEntityId",
	"dispatchTrace",
	"getEntityGeneration",
	"resolveECSMemory",
	"ringDespawnCodec",
	"ringDisableCodec",
	"ringEnableCodec",
	"ringRemoveComponentCodec",
	"ringSetFieldCodec"
];

describe("public API snapshot", () => {
	it("root runtime exports match the checked-in list", () => {
		expect(Object.keys(root).sort()).toEqual(ROOT_EXPORTS);
	});

	it("/internal runtime exports match the checked-in list", () => {
		expect(Object.keys(internal).sort()).toEqual(INTERNAL_EXPORTS);
	});

	it("internals do not leak through the root", () => {
		for (const name of INTERNAL_EXPORTS) {
			expect(ROOT_EXPORTS, `${name} must live on /internal only`).not.toContain(name);
		}
	});
});

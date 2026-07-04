/***
 * Compile-time typing assertions for the reactive bridge — never executed (see
 * `core/ecs/__tests__/typing_assertions.ts` for the mechanism: `tsc --noEmit`
 * validates every `@ts-expect-error` on each typecheck).
 ***/

import { syncJoinToMap, shallow } from "../ecs_sync";
import type { ComponentDef, ECS } from "../../../core/ecs";

declare const world: ECS;
declare const Pos: ComponentDef<{ x: "f64"; y: "f64" }>;
declare const Health: ComponentDef<{ hp: "f64" }>;
declare const Mana: ComponentDef<{ mp: "f64" }>;

function joinReaderAssertions(): void {
	const sync = syncJoinToMap(
		world,
		[Pos, Health],
		(row) => ({ x: row.field(Pos, "x"), hp: row.field(Health, "hp") }),
		{ eq: shallow }
	);
	// V flows from the projection (must survive the opts argument being present).
	const v: { x: number; hp: number } | undefined = sync.map.get(0 as never);
	void v;

	void syncJoinToMap(world, [Pos, Health], (row) => {
		// @ts-expect-error — Mana is not part of this join: its changes aren't
		// subscribed, so reading it would go stale (the module-header footgun).
		const stale = row.field(Mana, "mp");

		// @ts-expect-error — 'hp' is a Health field, not a Pos field
		const wrongField = row.field(Pos, "hp");

		return stale + wrongField;
	});
}

void joinReaderAssertions;

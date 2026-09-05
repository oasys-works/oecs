/***
 * The relations capability. Typed `(relation, target)` pairs between entities.
 *
 * Install it to give a world `ecs.relations`, the relation terms on a query
 * (`withRelation`, `hierarchy`, `forEachRelatedTo`), and the relation methods
 * on a system context. A world that does not install it carries neither the
 * service nor the relation store, and its destroy paths keep the branch they
 * already took when no relation was registered.
 *
 * Relations ride the sparse storage, which is core: a relation's membership and
 * its exclusive target field are a sparse component the service owns. That is
 * why installing this capability needs no sparse capability, and why a relation
 * add or remove still causes no archetype transition.
 *
 * The destroy paths are the one hot coupling. A dying entity must lose its
 * source role, and the target-death policy may cascade. Both are reached
 * through a null test the store hoists out of the batch loop, so a world
 * without relations runs the loop it ran before.
 ***/

import { RelationService } from "../core/ecs/relation_service";
import { ECSRelations } from "../core/ecs/facades";
import type { Capability, CapabilityHost } from "../core/ecs/capability";

/** The world surface this capability adds. */
export interface RelationsCapability {
	readonly relations: ECSRelations;
}

/** The relations capability, for `ECS.create({ plugins: [relations()] })`. */
export function relations(): Capability<RelationsCapability> {
	return {
		name: "relations",
		install(host: CapabilityHost): RelationsCapability {
			const store = host.store;
			store.installRelations(new RelationService(store.relationHost()));
			return { relations: new ECSRelations(store) };
		}
	};
}

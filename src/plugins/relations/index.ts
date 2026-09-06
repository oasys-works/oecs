/***
 * The relations plugin. Typed `(relation, target)` pairs between entities.
 *
 * Install it to give a world `ecs.relations`, the relation terms on a query
 * (`withRelation`, `hierarchy`, `forEachRelatedTo`), and the relation methods
 * on a system context. A world that does not install it carries neither the
 * service nor the relation store, and its destroy paths keep the branch they
 * already took when no relation was registered.
 *
 * Relations ride the sparse storage, which is core: a relation's membership and
 * its exclusive target field are a sparse component the service owns. That is
 * why installing this plugin needs no sparse plugin, and why a relation
 * add or remove still causes no archetype transition.
 *
 * The destroy paths are the one hot coupling. A dying entity must lose its
 * source role, and the target-death policy may cascade. Both are reached
 * through a null test the store hoists out of the batch loop, so a world
 * without relations runs the loop it ran before.
 ***/

import { RelationService } from "./relation_service";
import { ECSRelations } from "./facade";
import type { Plugin, PluginHost } from "../../core/ecs/plugin";

export { ECSRelations } from "./facade";
export { registerIsA, registerChildOf, type BuiltinRelationOptions } from "./builtin_relations";

/** The world surface this plugin adds. */
export interface RelationsPlugin {
	readonly relations: ECSRelations;
}

/** The relations plugin, for `ECS.create({ plugins: [relations()] })`. */
export function relations(): Plugin<RelationsPlugin> {
	return {
		name: "relations",
		install(host: PluginHost): RelationsPlugin {
			const store = host.store;
			const service = new RelationService(store.relationHost());
			store.installRelations(service);
			return { relations: new ECSRelations(service) };
		}
	};
}

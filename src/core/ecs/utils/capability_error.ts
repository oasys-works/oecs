/***
 * The two faults a world raises about a capability it did not install.
 *
 * These sit apart from the error vocabulary next door for one reason. The
 * capability bundles build in their own rollup graph, so the build resolves
 * every module both graphs reach to one package entry, and that entry has to
 * export the module's whole list. The classes next door are supported surface
 * and belong to the package root. These two helpers are tooling surface and
 * belong to the tooling entry. One file cannot answer to both entries, so they
 * live in two. `scripts/core_boundary.ts` carries the mapping.
 *
 * Cold path. Each one builds a message for a mistake at the construction site.
 ***/

import { ECSError, ECS_ERROR } from "./error";

/** The fault a world raises when a caller uses a subsystem it never installed.
 * Names the capability and the import that supplies it, because the remedy is
 * a construction-site edit and not a call-site one. */
export function capabilityMissingError(capability: string, api: string): ECSError {
	return new ECSError(
		ECS_ERROR.CAPABILITY_NOT_INSTALLED,
		`${api} needs the ${capability} capability, which this world did not install. ` +
			`Pass it at construction: ECS.create({ plugins: [${capability}()] }), ` +
			`imported from @oasys/oecs/${capability}`,
		{ capability }
	);
}

/** The fault a world raises when a capability reaches its install seam twice.
 * The install replaces the service, so the second one silently strands every
 * definition and handle the first one minted. */
export function capabilityInstalledTwiceError(capability: string): ECSError {
	return new ECSError(
		ECS_ERROR.CAPABILITY_ALREADY_INSTALLED,
		`${capability} is already installed on this world. ` +
			`Pass each capability once to ECS.create`,
		{ capability }
	);
}

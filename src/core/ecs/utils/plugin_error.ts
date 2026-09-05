/***
 * The two faults a world raises about a plugin it did not install.
 *
 * These sit apart from the error vocabulary next door for one reason. The
 * plugin bundles build in their own rollup graph, so the build resolves
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
 * Names the plugin and the import that supplies it, because the remedy is
 * a construction-site edit and not a call-site one. */
export function pluginMissingError(plugin: string, api: string): ECSError {
	return new ECSError(
		ECS_ERROR.PLUGIN_NOT_INSTALLED,
		`${api} needs the ${plugin} plugin, which this world did not install. ` +
			`Pass it at construction: ECS.create({ plugins: [${plugin}()] }), ` +
			`imported from @oasys/oecs/${plugin}`,
		{ plugin }
	);
}

/** The fault a world raises when a plugin reaches its install seam twice.
 * The install replaces the service, so the second one silently strands every
 * definition and handle the first one minted. */
export function pluginInstalledTwiceError(plugin: string): ECSError {
	return new ECSError(
		ECS_ERROR.PLUGIN_ALREADY_INSTALLED,
		`${plugin} is already installed on this world. ` +
			`Pass each plugin once to ECS.create`,
		{ plugin }
	);
}

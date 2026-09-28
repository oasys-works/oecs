/***
 * Access domain. A declared-access term for state a plugin owns.
 *
 * A system lists the domain in `domainReads` or `domainWrites`. The plugin's
 * own methods call `assertRead` or `assertWrite`. The rules are those of a
 * component term. A write implies a read, and an `exclusive` system passes.
 *
 * Identity is the key. The name is for the message only.
 *
 * The `DEV` gate is in the core, not in the plugin. Thus a plugin build
 * cannot disagree with the core build it runs against.
 ***/

import { DEV } from "../../dev_flag";
import { accessCheck } from "./access_check";
import type { AccessDomain } from "./access_domain_types";
export type { AccessDomain } from "./access_domain_types";

/** Make an access domain. Cold. */
export function accessDomain(name: string): AccessDomain {
	const domain: AccessDomain = Object.freeze({
		name,
		assertRead(): void {
			if (DEV) accessCheck.assertDomainRead(domain);
		},
		assertWrite(): void {
			if (DEV) accessCheck.assertDomainWrite(domain);
		}
	});
	return domain;
}

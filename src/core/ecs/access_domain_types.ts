/***
 * The access domain type. A leaf, so `access_domain.ts` and `access_check.ts`
 * do not form an import cycle.
 ***/

/** Plugin state that a system declares access to. Make one with
 * `accessDomain(name)`. */
export interface AccessDomain {
	/** For the error message only. */
	readonly name: string;
	/** Throw `ACCESS_UNDECLARED` when the running system declared this domain
	 * in neither `domainReads` nor `domainWrites`. Passes outside a system,
	 * in an `exclusive` system and in a production build. */
	assertRead(): void;
	/** Throw `ACCESS_UNDECLARED` when the running system did not declare this
	 * domain in `domainWrites`. Passes outside a system, in an `exclusive`
	 * system and in a production build. */
	assertWrite(): void;
}

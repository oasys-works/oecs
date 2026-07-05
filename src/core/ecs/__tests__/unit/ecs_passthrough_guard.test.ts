/**
 * ECS facade — pass-through band guard (H3 phase 1).
 *
 * `ecs.ts` ends with a marker-delimited "STORE PASS-THROUGH BAND": the
 * contiguous section holding every ECS method that is a *pure mechanical
 * delegation* to a collaborator (`this.store` / `this.schedule` / `this.ctx`
 * / `this._observers`). The band's invariant is that logic can never silently
 * accrete there — a method that grows a dev check, an argument adaptation, or
 * a second call has outgrown the band and must move above it, next to the
 * other real logic.
 *
 * This test enforces the invariant structurally: it parses `ecs.ts` with the
 * TypeScript compiler API and asserts every class member between the
 * BEGIN/END markers has one of exactly three body shapes:
 *
 *   1. `return this.<delegate>.<member>(…);`   (return delegation)
 *   2. `return this.<delegate>.<member>;`      (property-read delegation)
 *   3. `this.<delegate>.<member>(…);`          (void delegation)
 *      optionally followed by `return this;`   (chainable delegation)
 *
 * and that the body contains no other calls and no control flow. Arguments
 * may only forward parameters (identifiers / spreads) or supply inert
 * literals (e.g. `registerSignal`'s `[]`, `registerTag`'s `{}` cast).
 *
 * See plans/H3-ecs-facade-slimming.md (phase 1) and the band header comment
 * in ecs.ts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BEGIN_MARKER = "// === BEGIN STORE PASS-THROUGH BAND ===";
const END_MARKER = "// === END STORE PASS-THROUGH BAND ===";
const DELEGATES = new Set(["store", "schedule", "ctx", "_observers"]);

const ecsPath = fileURLToPath(new URL("../../ecs.ts", import.meta.url));
const source = readFileSync(ecsPath, "utf8");

/** `this.<delegate>.<member>` where `<delegate>` is an allowed collaborator. */
function isDelegateAccess(expr: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(expr) &&
		ts.isPropertyAccessExpression(expr.expression) &&
		expr.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
		DELEGATES.has(expr.expression.name.text)
	);
}

/** An argument may forward a parameter or supply an inert literal — never
 * compute. `as`-casts and parenthesization are transparent. */
function isInertArgument(arg: ts.Expression): boolean {
	if (ts.isSpreadElement(arg)) return isInertArgument(arg.expression);
	if (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg)) {
		return isInertArgument(arg.expression);
	}
	if (ts.isIdentifier(arg)) return true;
	if (
		ts.isStringLiteralLike(arg) ||
		ts.isNumericLiteral(arg) ||
		arg.kind === ts.SyntaxKind.TrueKeyword ||
		arg.kind === ts.SyntaxKind.FalseKeyword ||
		arg.kind === ts.SyntaxKind.NullKeyword ||
		arg.kind === ts.SyntaxKind.UndefinedKeyword
	) {
		return true;
	}
	if (ts.isArrayLiteralExpression(arg)) return arg.elements.every(isInertArgument);
	if (ts.isObjectLiteralExpression(arg)) {
		return arg.properties.every(
			(p) => ts.isPropertyAssignment(p) && isInertArgument(p.initializer)
		);
	}
	return false;
}

/** The single allowed call: `this.<delegate>.<member>(inert args…)`. */
function isDelegationCall(expr: ts.Expression): boolean {
	return (
		ts.isCallExpression(expr) &&
		isDelegateAccess(expr.expression) &&
		expr.arguments.every(isInertArgument)
	);
}

type Violation = { member: string; reason: string };

function checkBody(name: string, body: ts.Block, violations: Violation[]): void {
	const fail = (reason: string): void => {
		violations.push({ member: name, reason });
	};
	const stmts = body.statements;
	if (stmts.length === 1) {
		const s = stmts[0];
		if (ts.isReturnStatement(s) && s.expression !== undefined) {
			const e = s.expression;
			if (!isDelegationCall(e) && !isDelegateAccess(e)) {
				fail("single `return` is not a delegate call or property read");
			}
		} else if (ts.isExpressionStatement(s)) {
			if (!isDelegationCall(s.expression)) {
				fail("single statement is not a delegation call");
			}
		} else {
			fail("single statement is neither `return` nor a delegation call");
		}
	} else if (stmts.length === 2) {
		const [a, b] = stmts;
		const chainable =
			ts.isExpressionStatement(a) &&
			isDelegationCall(a.expression) &&
			ts.isReturnStatement(b) &&
			b.expression !== undefined &&
			b.expression.kind === ts.SyntaxKind.ThisKeyword;
		if (!chainable) fail("two statements are not `this.<delegate>.…(…); return this;`");
	} else {
		fail(`body has ${stmts.length} statements (max 2)`);
	}

	// Belt-and-braces: regardless of shape, the body may contain exactly one
	// call and zero control flow — catches logic smuggled into an argument
	// position or a nested expression the shape check missed.
	let callCount = 0;
	const walk = (node: ts.Node): void => {
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) callCount++;
		if (
			ts.isIfStatement(node) ||
			ts.isIterationStatement(node, false) ||
			ts.isSwitchStatement(node) ||
			ts.isTryStatement(node) ||
			ts.isConditionalExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			(ts.isBinaryExpression(node) &&
				(node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
					node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
					node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
		) {
			fail(`contains control flow / nested function (${ts.SyntaxKind[node.kind]})`);
		}
		node.forEachChild(walk);
	};
	walk(body);
	const isPropertyRead =
		stmts.length === 1 &&
		ts.isReturnStatement(stmts[0]) &&
		stmts[0].expression !== undefined &&
		!ts.isCallExpression(stmts[0].expression);
	if (isPropertyRead ? callCount !== 0 : callCount !== 1) {
		fail(`expected exactly ${isPropertyRead ? 0 : 1} call(s), found ${callCount}`);
	}
}

describe("ECS pass-through band (H3 phase 1)", () => {
	const beginOffset = source.indexOf(BEGIN_MARKER);
	const endOffset = source.indexOf(END_MARKER);

	it("has exactly one BEGIN and one END marker, in order", () => {
		expect(beginOffset).toBeGreaterThan(-1);
		expect(endOffset).toBeGreaterThan(beginOffset);
		expect(source.indexOf(BEGIN_MARKER, beginOffset + 1)).toBe(-1);
		expect(source.indexOf(END_MARKER, endOffset + 1)).toBe(-1);
	});

	const sf = ts.createSourceFile(ecsPath, source, ts.ScriptTarget.ES2022, true);
	let ecsClass: ts.ClassDeclaration | undefined;
	sf.forEachChild((n) => {
		if (ts.isClassDeclaration(n) && n.name?.text === "ECS") ecsClass = n;
	});

	const bandMembers = (ecsClass?.members ?? []).filter(
		(m) => m.getStart(sf) > beginOffset && m.getEnd() < endOffset
	);

	it("the band is populated (the markers actually delimit the delegations)", () => {
		expect(ecsClass).toBeDefined();
		// 38 delegating members after the 0.5.0 flat-form removal (the
		// relations/events/resources/snapshots delegations moved to the
		// facades). Shrinking is fine — methods may move out as H1
		// progresses — but an empty band means the markers drifted.
		expect(bandMembers.length).toBeGreaterThan(30);
		const names = new Set(
			bandMembers.map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : "?"))
		);
		// Spot-check members that must live in the band today.
		for (const expected of ["archetypeCount", "registerTag", "flush", "observe", "addSystems"]) {
			expect(names.has(expected), `expected ${expected} in the band`).toBe(true);
		}
	});

	it("every band member is a single mechanical delegation", () => {
		const violations: Violation[] = [];
		for (const m of bandMembers) {
			const name = m.name && ts.isIdentifier(m.name) ? m.name.text : "<unnamed>";
			if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) {
				// Overload signatures have no body — nothing to check.
				if (m.body !== undefined) checkBody(name, m.body, violations);
			} else if (ts.isSetAccessorDeclaration(m)) {
				violations.push({ member: name, reason: "setters do not belong in the band" });
			} else {
				violations.push({
					member: name,
					reason: `unexpected member kind ${ts.SyntaxKind[m.kind]} in the band`
				});
			}
		}
		expect(
			violations,
			violations.map((v) => `${v.member}: ${v.reason}`).join("\n")
		).toEqual([]);
	});
});

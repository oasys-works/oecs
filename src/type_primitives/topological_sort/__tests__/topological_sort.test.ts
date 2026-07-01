import { describe, expect, it } from "vitest";
import { topologicalSort } from "../topological_sort";

describe("topological_sort", () => {
  it("returns empty array for empty input", () => {
    const result = topologicalSort([], new Map(), (a, b) => a - b);
    expect(result).toEqual([]);
  });

  it("returns single node", () => {
    const result = topologicalSort([1], new Map(), (a, b) => a - b);
    expect(result).toEqual([1]);
  });

  it("sorts a linear chain A → B → C", () => {
    const edges = new Map<string, string[]>();
    edges.set("A", ["B"]);
    edges.set("B", ["C"]);
    const order = new Map([
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]);
    const result = topologicalSort(
      ["A", "B", "C"],
      edges,
      (a, b) => order.get(a)! - order.get(b)!,
    );
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("sorts diamond: A → B, A → C, B → D, C → D", () => {
    const edges = new Map<string, string[]>();
    edges.set("A", ["B", "C"]);
    edges.set("B", ["D"]);
    edges.set("C", ["D"]);
    const order = new Map([
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ]);
    const result = topologicalSort(
      ["A", "B", "C", "D"],
      edges,
      (a, b) => order.get(a)! - order.get(b)!,
    );
    expect(result[0]).toBe("A");
    expect(result[3]).toBe("D");
    expect(result[1]).toBe("B");
    expect(result[2]).toBe("C");
  });

  it("independent nodes maintain tiebreaker order", () => {
    const edges = new Map<string, string[]>();
    const order = new Map([
      ["X", 0],
      ["Y", 1],
      ["Z", 2],
    ]);
    const result = topologicalSort(
      ["X", "Y", "Z"],
      edges,
      (a, b) => order.get(a)! - order.get(b)!,
    );
    expect(result).toEqual(["X", "Y", "Z"]);
  });

  it("reversed insertion order is respected", () => {
    const edges = new Map<string, string[]>();
    const order = new Map([
      ["X", 2],
      ["Y", 1],
      ["Z", 0],
    ]);
    const result = topologicalSort(
      ["X", "Y", "Z"],
      edges,
      (a, b) => order.get(a)! - order.get(b)!,
    );
    expect(result).toEqual(["Z", "Y", "X"]);
  });

  it("throws on cycle", () => {
    const edges = new Map<string, string[]>();
    edges.set("A", ["B"]);
    edges.set("B", ["A"]);
    expect(() => topologicalSort(["A", "B"], edges, () => 0)).toThrow();
  });

  it("cycle error includes node names via node_name param", () => {
    const edges = new Map<string, string[]>();
    edges.set("A", ["B"]);
    edges.set("B", ["A"]);
    expect(() =>
      topologicalSort(
        ["A", "B"],
        edges,
        () => 0,
        (n) => n,
      ),
    ).toThrow(/A|B/);
  });

  it("constrained nodes come before dependents, unconstrained by tiebreaker", () => {
    const edges = new Map<string, string[]>();
    edges.set("A", ["D"]);
    const order = new Map([
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ]);
    const result = topologicalSort(
      ["A", "B", "C", "D"],
      edges,
      (a, b) => order.get(a)! - order.get(b)!,
    );
    expect(result.indexOf("A")).toBeLessThan(result.indexOf("D"));
  });
});

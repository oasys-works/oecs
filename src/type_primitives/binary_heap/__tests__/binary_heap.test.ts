import { describe, expect, it } from "vitest";
import { BinaryHeap } from "../binary_heap";

const minNum = (a: number, b: number) => a - b;
const maxNum = (a: number, b: number) => b - a;

describe("BinaryHeap", () => {
  //=========================================================
  // empty heap
  //=========================================================

  it("empty heap has size 0", () => {
    const h = new BinaryHeap<number>(minNum);
    expect(h.size).toBe(0);
  });

  it("pop on empty heap returns undefined", () => {
    const h = new BinaryHeap<number>(minNum);
    expect(h.pop()).toBeUndefined();
  });

  it("peek on empty heap returns undefined", () => {
    const h = new BinaryHeap<number>(minNum);
    expect(h.peek()).toBeUndefined();
  });

  //=========================================================
  // push / size
  //=========================================================

  it("push increases size", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(10);
    expect(h.size).toBe(1);
    h.push(20);
    expect(h.size).toBe(2);
    h.push(30);
    expect(h.size).toBe(3);
  });

  //=========================================================
  // peek
  //=========================================================

  it("peek returns the minimum without removing it", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(5);
    h.push(3);
    h.push(8);
    expect(h.peek()).toBe(3);
    expect(h.size).toBe(3);
  });

  it("peek returns same value on consecutive calls", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(7);
    h.push(2);
    expect(h.peek()).toBe(2);
    expect(h.peek()).toBe(2);
  });

  //=========================================================
  // pop — min-heap ordering
  //=========================================================

  it("pop returns elements in ascending order (min-heap)", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(5);
    h.push(3);
    h.push(8);
    h.push(1);
    h.push(4);
    expect(h.pop()).toBe(1);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(4);
    expect(h.pop()).toBe(5);
    expect(h.pop()).toBe(8);
    expect(h.pop()).toBeUndefined();
  });

  it("pop decreases size", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(10);
    h.push(20);
    h.push(30);
    h.pop();
    expect(h.size).toBe(2);
    h.pop();
    expect(h.size).toBe(1);
    h.pop();
    expect(h.size).toBe(0);
  });

  //=========================================================
  // max-heap via reversed comparator
  //=========================================================

  it("max-heap returns elements in descending order", () => {
    const h = new BinaryHeap<number>(maxNum);
    h.push(5);
    h.push(3);
    h.push(8);
    h.push(1);
    h.push(4);
    expect(h.pop()).toBe(8);
    expect(h.pop()).toBe(5);
    expect(h.pop()).toBe(4);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(1);
  });

  //=========================================================
  // duplicates
  //=========================================================

  it("handles duplicate values correctly", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(3);
    h.push(3);
    h.push(1);
    h.push(3);
    h.push(1);
    expect(h.size).toBe(5);
    expect(h.pop()).toBe(1);
    expect(h.pop()).toBe(1);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(3);
  });

  //=========================================================
  // single element
  //=========================================================

  it("single element: push then pop", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(42);
    expect(h.peek()).toBe(42);
    expect(h.pop()).toBe(42);
    expect(h.size).toBe(0);
  });

  //=========================================================
  // clear
  //=========================================================

  it("clear resets size to 0", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(1);
    h.push(2);
    h.push(3);
    h.clear();
    expect(h.size).toBe(0);
    expect(h.peek()).toBeUndefined();
    expect(h.pop()).toBeUndefined();
  });

  it("can push after clear", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(10);
    h.push(20);
    h.clear();
    h.push(5);
    expect(h.size).toBe(1);
    expect(h.peek()).toBe(5);
  });

  //=========================================================
  // interleaved push/pop
  //=========================================================

  it("interleaved push and pop maintain heap property", () => {
    const h = new BinaryHeap<number>(minNum);
    h.push(10);
    h.push(5);
    expect(h.pop()).toBe(5);
    h.push(3);
    h.push(8);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(8);
    h.push(1);
    expect(h.pop()).toBe(1);
    expect(h.pop()).toBe(10);
    expect(h.pop()).toBeUndefined();
  });

  //=========================================================
  // scale
  //=========================================================

  it("1000 elements are popped in sorted order", () => {
    const h = new BinaryHeap<number>(minNum);
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) {
      values.push(Math.floor(Math.random() * 10000));
    }
    for (let i = 0; i < values.length; i++) {
      h.push(values[i]);
    }
    expect(h.size).toBe(1000);

    const sorted = values.slice().sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      expect(h.pop()).toBe(sorted[i]);
    }
    expect(h.size).toBe(0);
  });

  //=========================================================
  // custom object comparator
  //=========================================================

  it("works with custom object comparator", () => {
    interface Task {
      name: string;
      priority: number;
    }
    const h = new BinaryHeap<Task>((a, b) => a.priority - b.priority);
    h.push({ name: "low", priority: 10 });
    h.push({ name: "high", priority: 1 });
    h.push({ name: "mid", priority: 5 });
    expect(h.pop()!.name).toBe("high");
    expect(h.pop()!.name).toBe("mid");
    expect(h.pop()!.name).toBe("low");
  });
});

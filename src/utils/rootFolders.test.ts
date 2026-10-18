import { describe, expect, it } from "vitest";
import {
  MAX_ROOT_FOLDERS,
  parseRootFolders,
  rootsSignature,
  type RootFolder,
} from "./rootFolders";

describe("parseRootFolders — valid input", () => {
  it("accepts a single root and normalizes id/name", () => {
    expect(parseRootFolders([{ id: " a ", name: " Music " }])).toEqual([
      { id: "a", name: "Music" },
    ]);
  });

  it("accepts two roots and preserves order (primary = index 0)", () => {
    const parsed = parseRootFolders([
      { id: "a", name: "First" },
      { id: "b", name: "Second" },
    ]);
    expect(parsed).toEqual([
      { id: "a", name: "First" },
      { id: "b", name: "Second" },
    ]);
    expect(parsed?.[0]?.id).toBe("a");
  });

  it("accepts exactly MAX_ROOT_FOLDERS roots, order preserved", () => {
    const input = Array.from({ length: MAX_ROOT_FOLDERS }, (_, i) => ({
      id: `id-${String(i)}`,
      name: `Root ${String(i)}`,
    }));
    expect(parseRootFolders(input)).toEqual(input);
  });

  it("strips extra properties, keeping only {id, name}", () => {
    const parsed = parseRootFolders([{ id: "a", name: "A", size: 1 }]);
    expect(parsed).toEqual([{ id: "a", name: "A" }]);
    expect(Object.keys(parsed?.[0] ?? {})).toEqual(["id", "name"]);
  });

  it("does not mutate the input array or its objects", () => {
    const input = [{ id: " a ", name: " A " }];
    parseRootFolders(input);
    expect(input).toEqual([{ id: " a ", name: " A " }]);
  });
});

describe("parseRootFolders — invalid input returns null", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "not-an-array"],
    ["a plain object", { id: "a", name: "A" }],
    ["an empty array", []],
  ])("rejects %s", (_label, value) => {
    expect(parseRootFolders(value)).toBeNull();
  });

  it("rejects more than MAX_ROOT_FOLDERS roots", () => {
    const input = Array.from({ length: MAX_ROOT_FOLDERS + 1 }, (_, i) => ({
      id: `id-${String(i)}`,
      name: `Root ${String(i)}`,
    }));
    expect(parseRootFolders(input)).toBeNull();
  });

  it.each([
    ["a null element", [null]],
    ["a string element", ["a"]],
    ["an element missing id", [{ name: "A" }]],
    ["an element missing name", [{ id: "a" }]],
    ["an empty id", [{ id: "", name: "A" }]],
    ["a whitespace-only id", [{ id: "   ", name: "A" }]],
    ["a non-string id", [{ id: 1, name: "A" }]],
    ["an empty name", [{ id: "a", name: "" }]],
    ["a whitespace-only name", [{ id: "a", name: "   " }]],
    ["a non-string name", [{ id: "a", name: 1 }]],
  ])("rejects %s", (_label, value) => {
    expect(parseRootFolders(value)).toBeNull();
  });

  it("rejects duplicate ids", () => {
    expect(
      parseRootFolders([
        { id: "a", name: "A" },
        { id: "a", name: "B" },
      ]),
    ).toBeNull();
  });

  it("rejects duplicate ids after trimming", () => {
    expect(
      parseRootFolders([
        { id: " a ", name: "A" },
        { id: "a", name: "B" },
      ]),
    ).toBeNull();
  });
});

describe("rootsSignature", () => {
  const roots = (ids: string[], names?: string[]): RootFolder[] =>
    ids.map((id, i) => ({ id, name: names?.[i] ?? id.toUpperCase() }));

  it("is stable for the same ids in the same order", () => {
    expect(rootsSignature(roots(["a", "b"]))).toBe(
      rootsSignature(roots(["a", "b"])),
    );
  });

  it("changes when the order changes", () => {
    expect(rootsSignature(roots(["a", "b"]))).not.toBe(
      rootsSignature(roots(["b", "a"])),
    );
  });

  it("changes when an id is added or removed", () => {
    expect(rootsSignature(roots(["a"]))).not.toBe(
      rootsSignature(roots(["a", "b"])),
    );
  });

  it("does not change when only a name changes", () => {
    expect(rootsSignature(roots(["a", "b"], ["One", "Two"]))).toBe(
      rootsSignature(roots(["a", "b"], ["Uno", "Dos"])),
    );
  });
});

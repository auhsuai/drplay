// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useState, useEffect } from "react";

function setStateHook() {
  const [v, setV] = useState(0);
  useEffect(() => {
    setV(0);
    return;
  }, []);
  return v;
}

describe("probe setState in effect", () => {
  it("one", () => {
    const { result } = renderHook(() => setStateHook());
    expect(result.current).toBe(0);
  });
  it("two", () => {
    const { result } = renderHook(() => setStateHook());
    expect(result.current).toBe(0);
  });
});

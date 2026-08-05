// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useState, useEffect } from "react";

function useSetStateHook() {
  const [v, setV] = useState(0);
  useEffect(() => {
    // probe: intentionally asserts React behavior for setState inside effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setV(0);
    return;
  }, []);
  return v;
}

describe("probe setState in effect", () => {
  it("one", () => {
    const { result } = renderHook(() => useSetStateHook());
    expect(result.current).toBe(0);
  });
  it("two", () => {
    const { result } = renderHook(() => useSetStateHook());
    expect(result.current).toBe(0);
  });
});

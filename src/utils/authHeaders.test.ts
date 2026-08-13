import { describe, expect, it } from "vitest";
import { authHeaders, authJsonHeaders } from "./authHeaders";

describe("authHeaders", () => {
  it("builds the Bearer Authorization header", () => {
    expect(authHeaders("tok-123")).toEqual({
      Authorization: "Bearer tok-123",
    });
  });

  it("keeps the token only in the value, never in the key", () => {
    const headers = authHeaders("tok-123");
    expect(Object.keys(headers)).toEqual(["Authorization"]);
    expect(headers.Authorization).toContain("tok-123");
  });
});

describe("authJsonHeaders", () => {
  it("adds the JSON content type on top of the bearer header", () => {
    expect(authJsonHeaders("tok-123")).toEqual({
      Authorization: "Bearer tok-123",
      "Content-Type": "application/json",
    });
  });
});

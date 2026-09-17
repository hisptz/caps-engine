import { describe, it, expect } from "vitest";
import { chapRequestHeaders } from "@/shared/clients/chap.ts";

describe("chapRequestHeaders", () => {
  it("omits Authorization when no token is set", () => {
    expect(chapRequestHeaders(undefined)).toEqual({
      "Content-Type": "application/json",
    });
    expect(chapRequestHeaders("")).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("sets Bearer Authorization when a token is provided", () => {
    expect(chapRequestHeaders("secret-token")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token",
    });
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig, PERMISSION_MODE_ENV } from "../src/index.js";

describe("configuration", () => {
  it("defaults to bypassPermissions", () => {
    expect(loadConfig({})).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("accepts a configured permission mode", () => {
    expect(loadConfig({ [PERMISSION_MODE_ENV]: "plan" })).toEqual({ permissionMode: "plan" });
  });

  it("rejects an invalid permission mode", () => {
    expect(() => loadConfig({ [PERMISSION_MODE_ENV]: "unsafe" })).toThrow(
      `${PERMISSION_MODE_ENV} must be one of`,
    );
  });
});

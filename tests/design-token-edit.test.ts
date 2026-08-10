import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileVersion } from "../server/file-version.mjs";
import { resolveDesignToken } from "../server/design-token-edit.mjs";

const GLOBAL_CSS = `:root {\n  --color-primary: #2563eb;\n  --spacing-unit: 0.25rem;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --color-primary: #60a5fa;\n  }\n}\n`;

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "anglesite-token-"));
  mkdirSync(join(projectRoot, "src", "styles"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "styles", "global.css"), GLOBAL_CSS);
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe("resolveDesignToken", () => {
  it("replaces the light :root declaration's value and leaves the dark block untouched", async () => {
    const result = await resolveDesignToken(projectRoot, {
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion: fileVersion(GLOBAL_CSS), token: "--color-primary", tokenValue: "#111111" },
    });
    const next = GLOBAL_CSS.slice(0, result.range.start) + result.replacement + GLOBAL_CSS.slice(result.range.end);
    expect(next).toContain("--color-primary: #111111;");
    expect(next).toContain("--color-primary: #60a5fa;"); // dark block unchanged
  });

  it("computes an inverse restoring the previous value", async () => {
    const result = await resolveDesignToken(projectRoot, {
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion: fileVersion(GLOBAL_CSS), token: "--color-primary", tokenValue: "#111111" },
    });
    expect(result.inverse).toEqual({
      op: "setDesignToken",
      component: { path: "src/styles/global.css", token: "--color-primary", tokenValue: "#2563eb" },
    });
  });

  it("refuses an unknown token rather than inventing a declaration", async () => {
    const result = await resolveDesignToken(projectRoot, {
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion: fileVersion(GLOBAL_CSS), token: "--does-not-exist", tokenValue: "red" },
    });
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("no-match");
  });
});

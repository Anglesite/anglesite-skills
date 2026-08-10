import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyEdit } from "../server/apply-edit-dispatcher.mjs";
import { fileVersion } from "../server/file-version.mjs";

const GLOBAL_CSS = `:root {\n  --color-primary: #2563eb;\n}\n`;

function parseContent(response) {
  return JSON.parse(response.content[0].text);
}

describe("applyEdit — setDesignToken", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "anglesite-aed-dt-"));
    mkdirSync(join(tmpDir, "src", "styles"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "styles", "global.css"), GLOBAL_CSS);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies setDesignToken end to end and stamps the inverse's post-write baseVersion", async () => {
    const baseVersion = fileVersion(GLOBAL_CSS);
    const response = await applyEdit(tmpDir, {
      id: "1",
      path: "src/styles/global.css",
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion, token: "--color-primary", tokenValue: "#111111" },
    });
    expect(response.isError).toBeFalsy();
    const body = parseContent(response);
    expect(body.type).toBe("anglesite:edit-applied");
    const onDisk = readFileSync(join(tmpDir, "src", "styles", "global.css"), "utf-8");
    expect(onDisk).toContain("--color-primary: #111111;");
    expect(body.inverse.component.tokenValue).toBe("#2563eb");
    expect(body.inverse.component.baseVersion).toBe(fileVersion(onDisk));
  });

  it("surfaces stale as a failed reply for a wrong baseVersion", async () => {
    const response = await applyEdit(tmpDir, {
      id: "1",
      path: "src/styles/global.css",
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion: "sha256:000000000000", token: "--color-primary", tokenValue: "#111111" },
    });
    expect(response.isError).toBe(true);
    const body = parseContent(response);
    expect(body.reason).toBe("stale");
  });

  // Regression for the dispatcher-level TOCTOU gap: setDesignToken is deliberately NOT a member
  // of COMPONENT_OPS (it doesn't target an Astro component — no payload-presence/model-refetch
  // semantics apply), but applyEdit still does a second, independent `readFileSync` after the
  // resolver returns and splices against THAT read. Without re-validating baseVersion against
  // this second read for every op that carries `component.baseVersion` (not just COMPONENT_OPS
  // members), a concurrent external write landing in the microtask gap between the resolver's
  // read and this second read would silently splice stale byte offsets into the new content.
  it("re-checks staleness against a write that lands in the async gap, refusing instead of corrupting the file", async () => {
    const baseVersion = fileVersion(GLOBAL_CSS);

    const editPromise = applyEdit(tmpDir, {
      id: "1",
      path: "src/styles/global.css",
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion, token: "--color-primary", tokenValue: "#111111" },
    });

    // Simulate a second write landing while this call is suspended at
    // `await resolveEdit(...)` in apply-edit-dispatcher.mjs — mirrors the equivalent
    // component-structure race test in apply-edit-dispatcher-component-structure.test.ts.
    const externallyWritten = `:root {\n  --color-primary: #2563eb;\n  --spacing-unit: 1rem;\n}\n`;
    writeFileSync(join(tmpDir, "src", "styles", "global.css"), externallyWritten);

    const response = await editPromise;
    expect(response.isError).toBe(true);
    const body = parseContent(response);
    expect(body.reason).toBe("stale");

    const onDisk = readFileSync(join(tmpDir, "src", "styles", "global.css"), "utf-8");
    expect(onDisk).toBe(externallyWritten); // untouched — no corrupted splice
  });
});

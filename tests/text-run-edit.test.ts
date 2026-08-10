import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "@astrojs/compiler";
import { buildTemplateNodeIndex } from "../server/component-node-index.mjs";
import { fileVersion } from "../server/file-version.mjs";
import { resolveTextRuns } from "../server/text-run-edit.mjs";

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "anglesite-text-run-"));
  mkdirSync(join(projectRoot, "src", "pages"), { recursive: true });
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

async function indexSource(source: string) {
  const { ast } = await parse(source, { position: true });
  return buildTemplateNodeIndex(ast, source);
}

describe("resolveTextRuns", () => {
  it("re-serializes runs as honest inline HTML, replacing the element's inner content", async () => {
    const source = `---\n---\n<p id="t">Hello world</p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const p = [...byId.values()].find((n) => n.tag === "p")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: {
        path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id,
        runs: [{ text: "Hello ", marks: [] }, { text: "world", marks: ["strong"] }],
      },
    });
    expect(result.replacement).toBe("Hello <strong>world</strong>");
  });

  it("escapes text content so a run's text can never break out as markup", async () => {
    const source = `---\n---\n<p id="t">old</p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const p = [...byId.values()].find((n) => n.tag === "p")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id, runs: [{ text: "<b>x</b> & y", marks: [] }] },
    });
    expect(result.replacement).toBe("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });

  it("computes an inverse editText restoring the original runs", async () => {
    const source = `---\n---\n<p id="t">Hello world</p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const p = [...byId.values()].find((n) => n.tag === "p")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id, runs: [{ text: "Bye", marks: [] }] },
    });
    expect(result.inverse).toEqual({
      op: "editText",
      component: { path: "src/pages/index.astro", textNodeId: p.id, runs: [{ text: "Hello world", marks: [] }] },
    });
  });
});

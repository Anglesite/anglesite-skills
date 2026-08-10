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

  // Fix round 1 — Critical: a literal ">" inside a quoted attribute value used to fool a naive
  // `indexOf(">", ...)` forward scan into landing inside the attribute list instead of past the
  // opening tag's real end, corrupting the splice. Reproduces the reviewer's exact repro case.
  it("resolves the inner-content boundary correctly when an attribute value contains a literal '>'", async () => {
    const source = `---\n---\n<p title="a>b">text</p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const p = [...byId.values()].find((n) => n.tag === "p")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id, runs: [{ text: "Bye", marks: ["strong"] }] },
    });
    expect(result.refused).toBeFalsy();
    // The attribute survives untouched, and the splice lands strictly inside the real
    // "text" content — not inside the attribute value (which would corrupt the tag).
    const spliced = source.slice(0, result.range.start) + result.replacement + source.slice(result.range.end);
    expect(spliced).toBe(`---\n---\n<p title="a>b"><strong>Bye</strong></p>\n`);
    expect(result.inverse.component.runs).toEqual([{ text: "text", marks: [] }]);
  });

  // Fix round 1 — Important 1: original content shaped like MULTIPLE runs (e.g. the normal shape
  // after a first edit) must fall back to the documented safe blunt inverse — one unmarked run of
  // the stripped text — rather than a garbled reconstruction that leaks literal tag text into the
  // run's `text` field.
  it("falls back to a single unmarked run when the original content has more than one run", async () => {
    const source = `---\n---\n<p id="t">Hello <strong>world</strong></p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const p = [...byId.values()].find((n) => n.tag === "p")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id, runs: [{ text: "Bye", marks: [] }] },
    });
    expect(result.inverse.component.runs).toEqual([{ text: "Hello world", marks: [] }]);
  });

  // Fix round 1 — Important 1 (positive case): a genuinely single-run, fully-marked original
  // (exactly the shape serializeRuns produces) still round-trips its marks precisely, so the
  // stricter fallback check isn't overly conservative.
  it("still recovers marks/text precisely for a genuine single marked run", async () => {
    const source = `---\n---\n<p id="t"><strong>Bye</strong></p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const p = [...byId.values()].find((n) => n.tag === "p")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id, runs: [{ text: "Hi", marks: [] }] },
    });
    expect(result.inverse.component.runs).toEqual([{ text: "Bye", marks: ["strong"] }]);
  });

  // Fix round 1 — Important 2: a component-kind node (an Astro component instance, e.g. a WYSIWYG
  // block) must be editable too, not just plain HTML elements — matches set-attr's uniform
  // element/component/slot treatment in component-structure-edit.mjs.
  it("edits a component-kind node's inner content", async () => {
    const source = `---\nimport Badge from "../components/Badge.astro";\n---\n<Badge>New</Badge>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const badge = [...byId.values()].find((n) => n.tag === "Badge")!;
    expect(badge.kind).toBe("component");
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: badge.id, runs: [{ text: "Sale", marks: [] }] },
    });
    expect(result.refused).toBeFalsy();
    expect(result.replacement).toBe("Sale");
    expect(result.inverse.component.runs).toEqual([{ text: "New", marks: [] }]);
  });

  // Minor: a void/self-closing element has no inner-content region at all — refuse cleanly
  // rather than guess.
  it("refuses cleanly for a self-closing element with no inner content region", async () => {
    const source = `---\n---\n<img id="t" src="x.jpg" />\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { byId } = await indexSource(source);
    const img = [...byId.values()].find((n) => n.tag === "img")!;
    const result = await resolveTextRuns(projectRoot, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: img.id, runs: [{ text: "x", marks: [] }] },
    });
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("no-match");
  });
});

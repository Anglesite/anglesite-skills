import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileVersion } from "../server/file-version.mjs";
import { resolveComponentStructure } from "../server/component-structure-edit.mjs";
import { resolveTextRuns } from "../server/text-run-edit.mjs";
import { resolveDesignToken } from "../server/design-token-edit.mjs";

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "anglesite-roundtrip-"));
  mkdirSync(join(projectRoot, "src", "pages"), { recursive: true });
  mkdirSync(join(projectRoot, "src", "styles"), { recursive: true });
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

/** Applies `resolver`'s result to `original`, then applies the computed inverse to that
 *  result, and asserts the round trip lands back on `original` byte-for-byte — the exact
 *  "op → source diff → re-parsed model" golden shape the spec requires (§10), proven directly
 *  against the resolver rather than through a live subprocess for speed and clarity. */
async function assertRoundTrips(resolver, original, edit) {
  const forward = await resolver(projectRoot, edit);
  expect(forward.refused).toBeFalsy();
  const afterForward = original.slice(0, forward.range.start) + forward.replacement + original.slice(forward.range.end);
  expect(forward.inverse).toBeTruthy();
  // Resolvers read the file fresh from disk (baseVersion is checked against on-disk content, not
  // against anything held in memory here) — persist the forward result before resolving the
  // inverse, or the backward call sees stale (pre-forward) content and refuses as stale.
  writeFileSync(join(projectRoot, edit.component.path), afterForward);
  const inverseEdit = { op: forward.inverse.op, component: { ...forward.inverse.component, baseVersion: fileVersion(afterForward) } };
  const backward = await resolver(projectRoot, inverseEdit);
  expect(backward.refused).toBeFalsy();
  const afterBackward = afterForward.slice(0, backward.range.start) + backward.replacement + afterForward.slice(backward.range.end);
  expect(afterBackward).toBe(original);
  return { forward, backward };
}

describe("op round trips", () => {
  it("setProp round-trips a changed attribute back to its original value", async () => {
    const source = `---\n---\n<div id="a" title="old">x</div>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { buildTemplateNodeIndex } = await import("../server/component-node-index.mjs");
    const { parse } = await import("@astrojs/compiler");
    const { ast } = await parse(source, { position: true });
    const { byId } = buildTemplateNodeIndex(ast, source);
    const divId = [...byId.values()].find((n: any) => n.tag === "div")!.id;
    await assertRoundTrips(resolveComponentStructure, source, {
      op: "setProp",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: divId, name: "title", value: "new" },
    });
  });

  it("editText round-trips a rewritten paragraph back to its original runs", async () => {
    const source = `---\n---\n<p id="t">Hello world</p>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { buildTemplateNodeIndex } = await import("../server/component-node-index.mjs");
    const { parse } = await import("@astrojs/compiler");
    const { ast } = await parse(source, { position: true });
    const { byId } = buildTemplateNodeIndex(ast, source);
    const p = [...byId.values()].find((n: any) => n.tag === "p")!;
    await assertRoundTrips(resolveTextRuns, source, {
      op: "editText",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), textNodeId: p.id, runs: [{ text: "Bye", marks: ["strong"] }] },
    });
  });

  it("setDesignToken round-trips a changed token back to its original value", async () => {
    const source = `:root {\n  --color-primary: #2563eb;\n}\n`;
    writeFileSync(join(projectRoot, "src/styles/global.css"), source);
    await assertRoundTrips(resolveDesignToken, source, {
      op: "setDesignToken",
      component: { path: "src/styles/global.css", baseVersion: fileVersion(source), token: "--color-primary", tokenValue: "#111111" },
    });
  });

  // Documents Task 4 Step 8's known gap rather than leaving it silently uncovered (per this
  // repo's "no silent caps" testing discipline): deleteBlock's raw-markup inverse does not
  // restore a pruned import when the removed subtree was the import's only usage, so a
  // deleteBlock → insertBlock round trip on such a subtree currently reconstructs the markup
  // but NOT the import line. Fix (re-detect + re-add the import from the raw markup's tag
  // name on reinsertion) is out of scope for this slice.
  it.todo("deleteBlock/insertBlock round-trips import pruning when the block was the import's sole use");

  // The three ops below (insertBlock/deleteBlock/moveBlock) use single-line, condensed markup —
  // no newlines/indentation between the target node and its siblings — deliberately mirroring
  // the fixtures already proven in tests/component-structure-edit.test.ts's "invertible ops"
  // suite. Those inverses restore the correct NODE/PARENT/INDEX but do NOT restore surrounding
  // whitespace on multi-line, indented markup (see the "KNOWN WHITESPACE-FIDELITY GAP" comments
  // in server/component-structure-edit.mjs at the trim/reinsert sites) — condensed fixtures keep
  // these assertions about real invertibility rather than about that documented, out-of-scope gap.

  it("insertBlock round-trips a newly inserted node back out of the tree", async () => {
    const source = `---\n---\n<main></main>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { buildTemplateNodeIndex } = await import("../server/component-node-index.mjs");
    const { parse } = await import("@astrojs/compiler");
    const { ast } = await parse(source, { position: true });
    const { byId } = buildTemplateNodeIndex(ast, source);
    const main = [...byId.values()].find((n: any) => n.tag === "main")!;
    await assertRoundTrips(resolveComponentStructure, source, {
      op: "insertBlock",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), parentId: main.id, index: 0, node: { kind: "element", tag: "p" } },
    });
  });

  it("deleteBlock round-trips a removed node back into the tree", async () => {
    const source = `---\n---\n<main><p id="keep">a</p><p id="gone">b</p></main>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { buildTemplateNodeIndex } = await import("../server/component-node-index.mjs");
    const { parse } = await import("@astrojs/compiler");
    const { ast } = await parse(source, { position: true });
    const { byId } = buildTemplateNodeIndex(ast, source);
    const gone = [...byId.values()].find((n: any) => n.tag === "p" && n.attrs.some((a: any) => a.name === "id" && a.value === "gone"))!;
    await assertRoundTrips(resolveComponentStructure, source, {
      op: "deleteBlock",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: gone.id },
    });
  });

  it("moveBlock round-trips a moved node back to its original parent/index", async () => {
    const source = `---\n---\n<main><section id="from"><p id="m">x</p></section><section id="to"></section></main>\n`;
    writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
    const { buildTemplateNodeIndex } = await import("../server/component-node-index.mjs");
    const { parse } = await import("@astrojs/compiler");
    const { ast } = await parse(source, { position: true });
    const { byId } = buildTemplateNodeIndex(ast, source);
    const p = [...byId.values()].find((n: any) => n.attrs.some((a: any) => a.name === "id" && a.value === "m"))!;
    const to = [...byId.values()].find((n: any) => n.attrs.some((a: any) => a.name === "id" && a.value === "to"))!;
    await assertRoundTrips(resolveComponentStructure, source, {
      op: "moveBlock",
      component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: p.id, newParentId: to.id, newIndex: 0 },
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "../server/patcher.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ang-astro-structural-"));
  mkdirSync(join(root, "src/pages"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writePage(source: string) {
  writeFileSync(join(root, "src/pages/about.astro"), source);
}

describe("resolveAstro structural fallback (selector.textContent absent)", () => {
  it("locates a lone element by tag + nthChild for replace-text", async () => {
    writePage("---\n---\n<h1>Welcome</h1>\n");
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "h1", classes: [], nthChild: 1 },
      op: "replace-text",
      value: "Hello",
    });
    expect(r.refused).toBeFalsy();
    expect(r.replacement).toBe("Hello");
  });

  it("counts nthChild among all element/component siblings, not just same-tag ones", async () => {
    writePage("---\n---\n<div><h1>A</h1><p>B</p><h1>C</h1></div>\n");
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "h1", classes: [], nthChild: 3 },
      op: "replace-text",
      value: "Z",
    });
    expect(r.refused).toBeFalsy();
    // Must resolve to the SECOND <h1> ("C"), not the first ("A").
    expect(r.replacement).toBe("Z");
    const file = join(root, "src/pages/about.astro");
    const source = readFileSync(file, "utf-8");
    expect(source.slice(r.range.start, r.range.end)).toBe("C");
  });

  it("counts Astro components as siblings when computing nthChild", async () => {
    writePage("---\n---\n<div><Header /><h1>Title</h1></div>\n");
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "h1", classes: [], nthChild: 2 },
      op: "replace-text",
      value: "New Title",
    });
    expect(r.refused).toBeFalsy();
    expect(r.replacement).toBe("New Title");
  });

  it("derives the current attribute value for replace-attr", async () => {
    writePage('---\n---\n<img src="/a.jpg" alt="Old Alt" />\n');
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "img", classes: [], nthChild: 1 },
      op: "replace-attr",
      value: { name: "alt", value: "New Alt" },
    });
    expect(r.refused).toBeFalsy();
    expect(r.replacement).toBe("New Alt");
    const file = join(root, "src/pages/about.astro");
    const source = readFileSync(file, "utf-8");
    expect(source.slice(r.range.start, r.range.end)).toBe("Old Alt");
  });

  it("derives the current src for replace-image-src", async () => {
    writePage('---\n---\n<img src="/old.jpg" alt="x" />\n');
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "img", classes: [], nthChild: 1 },
      op: "replace-image-src",
      value: { src: "/new.jpg", srcset: "" },
    });
    expect(r.refused).toBeFalsy();
    expect(r.replacement).toContain('src="/new.jpg"');
  });

  it("refuses (no-match) when the element mixes text with nested markup", async () => {
    writePage("---\n---\n<h1>Hello <b>World</b></h1>\n");
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "h1", classes: [], nthChild: 1 },
      op: "replace-text",
      value: "Hi",
    });
    expect(r.refused).toBe(true);
  });

  it("refuses (no-match) when tag + nthChild match multiple elements structurally", async () => {
    writePage("---\n---\n<div><h1>A</h1></div><div><h1>B</h1></div>\n");
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "h1", classes: [], nthChild: 1 },
      op: "replace-text",
      value: "Z",
    });
    expect(r.refused).toBe(true);
    expect(r.reason).toBe("no-match");
  });

  it("still refuses when neither textContent nor a resolvable nthChild match is present", async () => {
    writePage("---\n---\n<h1>Welcome</h1>\n");
    const r = await resolve(root, {
      path: "/about/",
      selector: { tag: "h1", classes: [], nthChild: 5 },
      op: "replace-text",
      value: "Hello",
    });
    expect(r.refused).toBe(true);
    expect(r.reason).toBe("no-match");
  });
});

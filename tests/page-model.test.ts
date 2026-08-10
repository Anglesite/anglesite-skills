import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPageModel, PageModelError } from "../server/page-model.mjs";

const HCARD = `---\ninterface Props { name: string; }\nconst { name } = Astro.props;\n---\n<div class="h-card">{name}</div>\n`;

const MANIFEST = JSON.stringify({
  schemaVersion: "anglesite-block-manifest/1",
  modules: [
    { path: "src/components/Hcard.astro", export: "Hcard", name: "Business Card", description: "An h-card.", propEditors: [{ prop: "name", editor: "text" }] },
  ],
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anglesite-page-model-"));
  mkdirSync(join(dir, "src", "pages"), { recursive: true });
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  writeFileSync(join(dir, "blocks.manifest.json"), MANIFEST);
  writeFileSync(join(dir, "src", "components", "Hcard.astro"), HCARD);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildPageModel", () => {
  it("annotates a manifest-registered component instance with its block descriptor", async () => {
    writeFileSync(
      join(dir, "src", "pages", "index.astro"),
      `---\nimport Hcard from "../components/Hcard.astro";\n---\n<main><Hcard name="Ana" /></main>\n`,
    );
    const model = await buildPageModel(dir, "src/pages/index.astro");
    expect(model.path).toBe("src/pages/index.astro");
    expect(model.version).toMatch(/^sha256:/);
    const main = model.tree.children.find((n) => n.tag === "main")!;
    const hcard = main.children.find((n) => n.tag === "Hcard")!;
    expect(hcard.block).toEqual({
      manifestPath: "src/components/Hcard.astro",
      name: "Business Card",
      description: "An h-card.",
      icon: null,
      propEditors: [{ prop: "name", editor: "text" }],
      slots: [],
    });
  });

  it("leaves an unregistered component's block field null", async () => {
    writeFileSync(
      join(dir, "src", "pages", "index.astro"),
      `---\n---\n<main><Untracked /></main>\n`,
    );
    const model = await buildPageModel(dir, "src/pages/index.astro");
    const untracked = model.tree.children.find((n) => n.tag === "main")!.children[0];
    expect(untracked.block).toBeNull();
  });

  it("throws PageModelError(invalid-input) for a non-.astro path", async () => {
    await expect(buildPageModel(dir, "src/pages/index.md")).rejects.toBeInstanceOf(PageModelError);
  });
});

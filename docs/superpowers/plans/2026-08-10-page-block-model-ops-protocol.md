# Page Block-Model Service + Ops Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the sidecar a page-level block-model read service (`get_page_model`) and a small
invertible semantic-ops vocabulary (`insertBlock`, `moveBlock`, `deleteBlock`, `setProp`,
`editText`, `setDesignToken`) that the WYSIWYG block editor (Anglesite-app #1221) will drive.

**Architecture:** Extends the Component Editor's proven read/write split rather than inventing a
parallel one. The read path (`get_page_model`) is `get_component_model`'s exact tree shape
(`component-node-index.mjs`'s shared depth-first walk) plus one enrichment pass that annotates
`kind: "component"` nodes against a new theme block manifest. The write path reuses
`apply_edit`'s existing `insert-node`/`move-node`/`remove-node`/`set-attr` resolvers verbatim —
those already operate on any `.astro` template, page or component — registering
`insertBlock`/`moveBlock`/`deleteBlock`/`setProp` as protocol-facing names for the same dispatch,
and adding the one capability that doesn't exist yet anywhere in the codebase: **every structural
op now computes and returns its own inverse**. `editText` (rich-text runs) and `setDesignToken`
(global CSS custom properties) are genuinely new resolvers modeled on the existing
`component-style-edit.mjs`/`style-edit.mjs` splice-and-write conventions.

**Tech Stack:** Node.js (`server/*.mjs`, plain ESM, untyped), `@astrojs/compiler` (Astro template
AST), `css-tree` (CSS parsing), `zod` (MCP tool input schemas), Vitest (`tests/*.test.ts` +
`test/*.test.js`).

## Global Constraints

- **MCP schema change → paired PR.** Per `Anglesite-app/CLAUDE.md` ▸ Two-repo coordination, this
  entire plan ships as a sidecar PR first; the Anglesite-app consumer PR follows once this one is
  tagged and released. Do not start the app-side PR from this plan.
- **Never trust `node.span`/`position.offset` off a fresh `@astrojs/compiler` parse** for
  element/component/slot/fragment/expression nodes — always re-derive via `resolveAllSpans`
  (lexical relocation) before splicing. This is existing, hard-won discipline in
  `component-structure-edit.mjs`; every new resolver in this plan follows it.
- **Content-hash staleness guard on every write.** Every mutating op carries `baseVersion`; every
  resolver re-reads the file fresh and refuses with reason `"stale"` on mismatch
  (`fileVersion()` from `server/file-version.mjs`, unchanged).
- **No AST re-print — string-splice patches only**, matching every existing resolver
  (`{file, range, replacement}`). Do not introduce a re-serializing formatter.
- **No new runtime dependencies beyond what's already in the root `package.json`**
  (`@astrojs/compiler`, `css-tree`, `zod` transitively via `@modelcontextprotocol/sdk`) — the spec
  explicitly rejected a markdown/mdast parser for this slice (§4: "Content pages stay
  markdown/MDX... `editText` ops write markdown / semantic HTML runs"); `editText` in this plan
  is scoped to `.astro` template rich-text nodes only (see Task 6's Scope Note) precisely to avoid
  needing one. If a future slice needs Markdoc body editing, that is new dependency-approval work,
  not a silent extension of this plan.
- **`server/` stays flat** — no subdirectories. New files land directly in `server/` following the
  existing `component-*`/`page-*` naming convention.
- **Tests:** unit tests in `tests/*.test.ts` (Vitest, TypeScript) mirroring
  `tests/component-model.test.ts`/`tests/component-structure-edit.test.ts`; end-to-end stdio round
  trips added as new `it()` blocks in `tests/mcp-server.test.ts`. Run `npm test` (`vitest run`)
  after every task.

---

## File Structure

```
server/
├── component-node-index.mjs      MODIFY — export toPublicNode() (moved from component-model.mjs)
├── component-model.mjs           MODIFY — import toPublicNode instead of a local copy
├── component-structure-edit.mjs  MODIFY — inverse computation, `raw` insert kind, alias dispatch
├── block-manifest-schema.mjs     NEW — zod schema for the theme's blocks.manifest.json
├── block-manifest.mjs            NEW — loadBlockManifest(), indexManifestByPath/Name()
├── page-model.mjs                NEW — buildPageModel() — get_page_model backend
├── apply-edit-schema.mjs         MODIFY — new op names, `raw`/`manifestBlock` fields, editText/
│                                          setDesignToken payload shapes
├── apply-edit-dispatcher.mjs     MODIFY — stamp inverse.component.baseVersion post-write
├── patcher.mjs                   MODIFY — route new op names to their resolvers
├── text-run-edit.mjs             NEW — editText resolver (rich-text runs → HTML/inline markup)
├── css-rule-index.mjs            MODIFY — factor out a baseOffset-free declaration walk
├── design-token-edit.mjs         NEW — setDesignToken resolver (global.css :root custom props)
└── index-tools.mjs               MODIFY — register get_page_model

tests/
├── page-model.test.ts            NEW
├── component-structure-edit.test.ts  MODIFY — inverse assertions on existing ops
├── text-run-edit.test.ts         NEW
├── design-token-edit.test.ts     NEW
├── page-ops-roundtrip.test.ts    NEW — golden op → source diff → re-parsed model round trips
└── mcp-server.test.ts            MODIFY — get_page_model + new ops over stdio
```

---

## Task 1: Share `toPublicNode` between the component and page models

**Files:**
- Modify: `server/component-node-index.mjs`
- Modify: `server/component-model.mjs:104-117` (removes the private `toPublicNode`)
- Test: `tests/component-model.test.ts` (existing suite — must still pass unchanged)

**Interfaces:**
- Produces: `toPublicNode(byId: Map<string, IndexedNode>, id: string): TemplateNode` — exported
  from `component-node-index.mjs`, consumed by both `component-model.mjs` (Task unchanged) and
  `page-model.mjs` (Task 3).

- [ ] **Step 1: Move `toPublicNode` into `component-node-index.mjs` and export it**

Add to the end of `server/component-node-index.mjs`:

```js
/** Projects one indexed node (and its subtree) into the public TemplateNode shape returned by
 *  get_component_model / get_page_model. Shared so both read paths serialize identically. */
export function toPublicNode(byId, id) {
  const r = byId.get(id);
  const node = {
    id: r.id,
    kind: r.kind,
    tag: r.tag,
    attrs: r.attrs.map(({ name, value }) => ({ name, value })),
    span: r.span,
    loc: r.loc,
    children: r.childIds.map((cid) => toPublicNode(byId, cid)),
  };
  if (r.text !== undefined) node.text = r.text;
  return node;
}
```

- [ ] **Step 2: Delete the private copy in `component-model.mjs` and import the shared one**

```js
// server/component-model.mjs — top of file
import { buildTemplateNodeIndex, buildLineStarts, offsetFromLineColumn, toPublicNode } from "./component-node-index.mjs";
```

Delete the `function toPublicNode(byId, id) { ... }` block (lines 104-117 in the current file).

- [ ] **Step 3: Run the existing suite to confirm the refactor is behavior-preserving**

Run: `npx vitest run tests/component-model.test.ts`
Expected: PASS, identical to before the move (no assertions change — this step is pure
relocation).

- [ ] **Step 4: Commit**

```bash
git add server/component-node-index.mjs server/component-model.mjs
git commit -m "refactor(server): share toPublicNode for the upcoming page-model read path"
```

---

## Task 2: Theme block manifest — schema and loader

**Files:**
- Create: `server/block-manifest-schema.mjs`
- Create: `server/block-manifest.mjs`
- Test: `tests/block-manifest.test.ts`

**Interfaces:**
- Produces: `loadBlockManifest(projectRoot: string): BlockManifest`,
  `indexManifestByPath(manifest): Map<string, BlockManifestModule>`,
  `indexManifestByName(manifest): Map<string, BlockManifestModule>`, `BlockManifestError` (reasons
  `"parse-failed"` | `"invalid-manifest"`). Consumed by `page-model.mjs` (Task 3) and
  `component-structure-edit.mjs`'s manifest-aware `insertBlock` (Task 4).
- Design decision (record here, not self-evident from the spec): the theme manifest is a
  **project-root file `blocks.manifest.json`**, not a per-component sidecar file or a generated
  artifact — CEM itself is normally one `custom-elements.json` per package, and a single file is
  what a theme author (or, later, an app-side "regenerate manifest" action) edits directly. A
  theme with none — the case for every existing scaffolded site today — is valid: `get_page_model`
  degrades to "no blocks recognized, everything is opaque markup," never a hard failure.

- [ ] **Step 1: Write the failing schema test**

Create `tests/block-manifest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { blockManifestSchema } from "../server/block-manifest-schema.mjs";

describe("blockManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const result = blockManifestSchema.safeParse({
      schemaVersion: "anglesite-block-manifest/1",
      modules: [
        {
          path: "src/components/Hcard.astro",
          export: "Hcard",
          kind: "astro",
          name: "Business Card",
          description: "Name, photo, and contact details as an h-card.",
          icon: null,
          propEditors: [{ prop: "name", editor: "text" }],
          slots: [],
          placement: { allowedParents: null },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown propEditor kind", () => {
    const result = blockManifestSchema.safeParse({
      schemaVersion: "anglesite-block-manifest/1",
      modules: [
        {
          path: "src/components/Hcard.astro",
          export: "Hcard",
          name: "Business Card",
          propEditors: [{ prop: "name", editor: "not-a-real-editor" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails (module doesn't exist yet)**

Run: `npx vitest run tests/block-manifest.test.ts`
Expected: FAIL with "Cannot find module '../server/block-manifest-schema.mjs'"

- [ ] **Step 3: Write `server/block-manifest-schema.mjs`**

```js
import { z } from "zod";

export const propEditorKinds = ["text", "richtext", "image", "boolean", "number", "select", "color", "array"];

const blockManifestModuleSchema = z.object({
  path: z.string().describe("Project-relative component path, e.g. src/components/Hcard.astro"),
  export: z.string().describe("Default export name as imported, e.g. Hcard"),
  kind: z.enum(["astro", "custom-element"]).default("astro"),
  name: z.string().describe("Owner-facing block name shown in the Insert menu/palette"),
  description: z.string().default(""),
  icon: z.string().nullable().default(null),
  propEditors: z
    .array(
      z.object({
        prop: z.string(),
        editor: z.enum(propEditorKinds),
        options: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  slots: z.array(z.string()).default([]),
  placement: z.object({ allowedParents: z.array(z.string()).nullable().default(null) }).default({ allowedParents: null }),
});

export const blockManifestSchema = z.object({
  schemaVersion: z.literal("anglesite-block-manifest/1"),
  readme: z.string().optional(),
  modules: z.array(blockManifestModuleSchema),
});
```

- [ ] **Step 4: Run it again to verify the schema tests pass**

Run: `npx vitest run tests/block-manifest.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing loader test**

Append to `tests/block-manifest.test.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBlockManifest, indexManifestByPath, indexManifestByName, BlockManifestError } from "../server/block-manifest.mjs";

describe("loadBlockManifest", () => {
  it("returns an empty manifest when blocks.manifest.json is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "anglesite-manifest-"));
    try {
      const manifest = loadBlockManifest(dir);
      expect(manifest.modules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads, validates, and indexes a real manifest file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anglesite-manifest-"));
    try {
      writeFileSync(
        join(dir, "blocks.manifest.json"),
        JSON.stringify({
          schemaVersion: "anglesite-block-manifest/1",
          modules: [{ path: "src/components/Hcard.astro", export: "Hcard", name: "Business Card" }],
        }),
      );
      const manifest = loadBlockManifest(dir);
      expect(indexManifestByPath(manifest).get("src/components/Hcard.astro")?.name).toBe("Business Card");
      expect(indexManifestByName(manifest).get("Business Card")?.path).toBe("src/components/Hcard.astro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws BlockManifestError with reason invalid-manifest on schema violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "anglesite-manifest-"));
    try {
      writeFileSync(join(dir, "blocks.manifest.json"), JSON.stringify({ schemaVersion: "wrong", modules: [] }));
      expect(() => loadBlockManifest(dir)).toThrow(BlockManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/block-manifest.test.ts`
Expected: FAIL with "Cannot find module '../server/block-manifest.mjs'"

- [ ] **Step 7: Write `server/block-manifest.mjs`**

```js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { blockManifestSchema } from "./block-manifest-schema.mjs";

export class BlockManifestError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const MANIFEST_FILENAME = "blocks.manifest.json";

/** Loads and validates the theme's block manifest from the project root. A missing file is
 *  valid (empty manifest) — every component in the page tree simply stays unregistered rather
 *  than failing get_page_model. A present-but-invalid file throws. */
export function loadBlockManifest(projectRoot) {
  const absPath = join(projectRoot, MANIFEST_FILENAME);
  if (!existsSync(absPath)) return { schemaVersion: "anglesite-block-manifest/1", modules: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf-8"));
  } catch (err) {
    throw new BlockManifestError("parse-failed", `parse ${MANIFEST_FILENAME}: ${err.message}`);
  }
  const parsed = blockManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BlockManifestError(
      "invalid-manifest",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

export function indexManifestByPath(manifest) {
  return new Map(manifest.modules.map((m) => [m.path, m]));
}

export function indexManifestByName(manifest) {
  return new Map(manifest.modules.map((m) => [m.name, m]));
}
```

- [ ] **Step 8: Run the full file to verify all pass**

Run: `npx vitest run tests/block-manifest.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 9: Commit**

```bash
git add server/block-manifest-schema.mjs server/block-manifest.mjs tests/block-manifest.test.ts
git commit -m "feat(server): add theme block-manifest schema and loader"
```

---

## Task 3: `get_page_model` — the page-level block-model read service

**Files:**
- Create: `server/page-model.mjs`
- Modify: `server/index-tools.mjs` (register the tool, alongside `get_component_model` at
  line ~148)
- Test: `tests/page-model.test.ts`
- Test: `tests/mcp-server.test.ts` (append one `it()` for the stdio round trip)

**Interfaces:**
- Consumes: `buildTemplateNodeIndex`, `toPublicNode` (Task 1) from `component-node-index.mjs`;
  `parseImports` from `frontmatter-imports.mjs`; `loadBlockManifest`, `indexManifestByPath`
  (Task 2) from `block-manifest.mjs`; `fileVersion` from `file-version.mjs`.
- Produces: `buildPageModel(projectRoot: string, relPath: string): Promise<PageModel>`,
  `PageModelError` (reasons `"invalid-input"` | `"read-failed"` | `"parse-failed"`), where
  `PageModel = { version: string, path: string, tree: PageNode }` and `PageNode` is a
  `TemplateNode` (Task 1's shape) plus one added field: `block: BlockDescriptor | null`.
  `BlockDescriptor = { manifestPath: string, name: string, description: string, icon: string |
  null, propEditors: PropEditor[], slots: string[] }`. This is what Task 4's manifest-aware
  `insertBlock` and the app-side editor both consume.

- [ ] **Step 1: Write the failing test — block annotation on a manifest-registered component**

Create `tests/page-model.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/page-model.test.ts`
Expected: FAIL with "Cannot find module '../server/page-model.mjs'"

- [ ] **Step 3: Write `server/page-model.mjs`**

```js
import { readFileSync } from "node:fs";
import { join, normalize, dirname, sep } from "node:path";
import { parse } from "@astrojs/compiler";
import { fileVersion } from "./file-version.mjs";
import { buildTemplateNodeIndex, toPublicNode } from "./component-node-index.mjs";
import { parseImports } from "./frontmatter-imports.mjs";
import { loadBlockManifest, indexManifestByPath } from "./block-manifest.mjs";

export class PageModelError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

function validPagePath(relPath) {
  return (
    typeof relPath === "string" &&
    relPath.endsWith(".astro") &&
    !normalize(relPath).startsWith("..") &&
    !relPath.startsWith("/")
  );
}

/** Resolves each locally-imported tag name to a project-relative path via the page's own
 *  frontmatter default imports — the join key against the block manifest's `path` field.
 *  Only relative specifiers are resolved; a package import is never a theme block. */
function resolveComponentPaths(relPath, frontmatterSource) {
  const pageDir = dirname(relPath);
  const byLocalName = new Map();
  for (const { localName, specifier } of parseImports(frontmatterSource ?? "")) {
    if (!specifier.startsWith(".")) continue;
    const resolved = normalize(join(pageDir, specifier)).split(sep).join("/");
    byLocalName.set(localName, resolved);
  }
  return byLocalName;
}

function annotateBlocks(node, byLocalName, manifestByPath) {
  let block = null;
  if (node.kind === "component" && node.tag) {
    const path = byLocalName.get(node.tag);
    const entry = path ? manifestByPath.get(path) : undefined;
    if (entry) {
      block = {
        manifestPath: entry.path,
        name: entry.name,
        description: entry.description,
        icon: entry.icon,
        propEditors: entry.propEditors,
        slots: entry.slots,
      };
    }
  }
  return { ...node, block, children: node.children.map((c) => annotateBlocks(c, byLocalName, manifestByPath)) };
}

export async function buildPageModel(projectRoot, relPath) {
  if (!validPagePath(relPath)) {
    throw new PageModelError("invalid-input", `not a project-relative .astro path: ${relPath}`);
  }
  const absPath = join(projectRoot, relPath);
  let source;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (err) {
    throw new PageModelError("read-failed", `read ${relPath}: ${err.message}`);
  }
  let ast;
  try {
    ({ ast } = await parse(source, { position: true }));
  } catch (err) {
    throw new PageModelError("parse-failed", `parse ${relPath}: ${err.message}`);
  }
  const { byId, rootId } = buildTemplateNodeIndex(ast, source);
  const tree = toPublicNode(byId, rootId);
  const fmNode = (ast.children ?? []).find((n) => n.type === "frontmatter");
  const byLocalName = resolveComponentPaths(relPath, fmNode?.value ?? "");
  const manifestByPath = indexManifestByPath(loadBlockManifest(projectRoot));
  return { version: fileVersion(source), path: relPath, tree: annotateBlocks(tree, byLocalName, manifestByPath) };
}
```

- [ ] **Step 4: Run to verify the unit tests pass**

Run: `npx vitest run tests/page-model.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the MCP tool**

In `server/index-tools.mjs`, add the import near the top (alongside the existing
`buildComponentModel`/`ComponentModelError` import):

```js
import { buildPageModel, PageModelError } from "./page-model.mjs";
```

Add the tool registration directly after the existing `get_component_model` registration
(~line 178):

```js
server.tool(
  "get_page_model",
  "Parse a page .astro file into a block-annotated template tree: the same node shape get_component_model returns, with each component instance that resolves to a theme block-manifest entry carrying owner-facing name/description/icon/propEditors/slots. Used by the WYSIWYG block editor.",
  {
    path: z.string().describe("Page path relative to the project root, e.g. src/pages/index.astro"),
  },
  async ({ path }) => {
    try {
      const model = await buildPageModel(projectRoot, path);
      return { content: [{ type: "text", text: JSON.stringify(model) }] };
    } catch (err) {
      const reason = err instanceof PageModelError ? err.reason : "internal-error";
      return {
        content: [
          { type: "text", text: JSON.stringify({ type: "anglesite:page-model-failed", reason, detail: String(err?.message ?? err) }) },
        ],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 6: Write the failing stdio round-trip test**

Append to `tests/mcp-server.test.ts`, near the existing `it("get_component_model returns a
structured model over stdio", …)` block (~line 505), reusing the file's existing `startServer`/
`initialize`/`callTool` helpers:

```ts
it("get_page_model returns a block-annotated tree over stdio", async () => {
  mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
  mkdirSync(join(tmpDir, "src", "components"), { recursive: true });
  writeFileSync(
    join(tmpDir, "blocks.manifest.json"),
    JSON.stringify({ schemaVersion: "anglesite-block-manifest/1", modules: [{ path: "src/components/Hcard.astro", export: "Hcard", name: "Business Card" }] }),
  );
  writeFileSync(join(tmpDir, "src", "components", "Hcard.astro"), `---\n---\n<div>card</div>\n`);
  writeFileSync(
    join(tmpDir, "src", "pages", "index.astro"),
    `---\nimport Hcard from "../components/Hcard.astro";\n---\n<Hcard />\n`,
  );
  const result = await callTool(proc, "get_page_model", { path: "src/pages/index.astro" });
  const model = JSON.parse(result.content[0].text);
  expect(model.tree.children[0].block.name).toBe("Business Card");
});
```

- [ ] **Step 7: Run the full suite to verify everything passes**

Run: `npm test`
Expected: PASS, no regressions in any existing suite.

- [ ] **Step 8: Commit**

```bash
git add server/page-model.mjs server/index-tools.mjs tests/page-model.test.ts tests/mcp-server.test.ts
git commit -m "feat(server): add get_page_model block-annotated page tree service"
```

---

## Task 4: Invertible structural ops — `insertBlock`/`moveBlock`/`deleteBlock`/`setProp`

**Files:**
- Modify: `server/apply-edit-schema.mjs` (new op names, `raw` insert kind, `manifestBlock` field)
- Modify: `server/component-structure-edit.mjs` (inverse computation, alias dispatch, `raw` kind)
- Modify: `server/patcher.mjs` (route the new op names)
- Test: `tests/component-structure-edit.test.ts` (append inverse assertions)

**Interfaces:**
- Consumes: `resolveAllSpans`, `SpanResolutionError`, `collectComponentTags`, `escapeAttr`
  (already exported from `component-structure-edit.mjs`); `indexManifestByName` (Task 2) for
  `insertBlock`'s `manifestBlock` resolution.
- Produces: every `apply*` resolver in `component-structure-edit.mjs` now returns
  `{ file, range, replacement, inverse }` on success, where `inverse` is an **unstamped** op
  object `{ op: string, component: object }` (no `baseVersion` yet — Task 5 stamps it after the
  write completes, since the inverse targets the *post-edit* file version). `editOps` gains four
  new entries: `"insertBlock"`, `"moveBlock"`, `"deleteBlock"`, `"setProp"` — each dispatched
  identically to `insert-node`/`move-node`/`remove-node`/`set-attr` (a canonical-name lookup, not
  a duplicated switch arm). `componentEditSchema.node.kind` gains `"raw"` (a `markup` string
  spliced verbatim, no import handling) — this is what lets `deleteBlock`'s inverse reconstruct
  an exact removed subtree without a second typed-insert code path.

- [ ] **Step 1: Write the failing inverse test for `setProp` (the simplest case)**

Append to `tests/component-structure-edit.test.ts`:

```ts
it("setProp's inverse restores the previous attribute value", async () => {
  const source = `---\n---\n<div id="a" title="old">x</div>\n`;
  const { byId, rootId } = /* existing test helper that parses `source` into byId/rootId */ await indexSource(source);
  const divId = [...byId.values()].find((n) => n.tag === "div")!.id;
  const result = await resolveComponentStructure(projectRoot, {
    op: "setProp",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: divId, name: "title", value: "new" },
  });
  expect(result.inverse).toEqual({
    op: "setProp",
    component: { path: "src/pages/index.astro", nodeId: divId, name: "title", value: "old" },
  });
});

it("setProp's inverse removes an attribute that didn't exist before", async () => {
  const source = `---\n---\n<div id="a">x</div>\n`;
  const { byId } = await indexSource(source);
  const divId = [...byId.values()].find((n) => n.tag === "div")!.id;
  const result = await resolveComponentStructure(projectRoot, {
    op: "setProp",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: divId, name: "title", value: "new" },
  });
  expect(result.inverse.component.value).toBeNull();
});
```

(`indexSource` is a small helper to add at the top of the test file — writes `source` to a temp
`.astro` file and returns `buildTemplateNodeIndex` over it; follow the existing file's
`beforeEach`/`afterEach` tmpdir pattern for `projectRoot`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/component-structure-edit.test.ts -t "inverse"`
Expected: FAIL — `result.inverse` is `undefined` (the field doesn't exist yet).

- [ ] **Step 3: Add `raw` to the node-spec union and `manifestBlock` to `componentEditSchema`**

In `server/apply-edit-schema.mjs`, extend `editOps`:

```js
export const editOps = [
  "replace-text",
  "replace-attr",
  "replace-image-src",
  "edit-style",
  "apply-instruction",
  "set-style-property",
  "remove-style-property",
  "add-style-rule",
  "set-rule-selector",
  "insert-node",
  "move-node",
  "remove-node",
  "set-attr",
  "insertBlock",
  "moveBlock",
  "deleteBlock",
  "setProp",
  "editText",
  "setDesignToken",
  "set-props-interface",
  "set-script-zone",
  "extract-component",
];

/** insertBlock/moveBlock/deleteBlock/setProp are protocol-facing aliases for the identical
 *  insert-node/move-node/remove-node/set-attr dispatch (see COMPONENT_STRUCTURE_OPS below) —
 *  the WYSIWYG ops-protocol vocabulary (spec 2026-08-03-modern-wysiwyg-editor-design.md §3.2)
 *  targeting the exact same span-resolution machinery, now with a computed inverse attached. */
export const COMPONENT_STRUCTURE_OPS = new Set([
  "insert-node", "move-node", "remove-node", "set-attr",
  "insertBlock", "moveBlock", "deleteBlock", "setProp",
]);
```

Add `manifestBlock` and extend `node.kind` in `componentEditSchema`:

```js
  node: z
    .object({
      kind: z.enum(["element", "component", "slot", "raw"]),
      tag: z.string().optional().describe("HTML tag name (element) or component name (component); omitted for slot/raw"),
      componentPath: z.string().optional().describe("Project-relative .astro path to import, required when kind=component"),
      slotName: z.string().optional().describe("Named slot, for kind=slot; omitted means the default slot"),
      markup: z.string().optional().describe("Verbatim source markup to splice in as-is, required when kind=raw — used by deleteBlock's computed inverse to reconstruct an exact removed subtree"),
    })
    .optional()
    .describe("New node spec for insert-node/insertBlock"),
  manifestBlock: z
    .string()
    .optional()
    .describe("Owner-facing block-manifest name for insertBlock (e.g. \"Business Card\") — resolved server-side to {tag, componentPath} via blocks.manifest.json instead of the caller supplying them directly. Mutually exclusive with node.tag/node.componentPath."),
```

Add `editText` and `setDesignToken` payload fields (used by Tasks 6-7; adding now keeps the enum
and its payload shape changes in one place):

```js
  textNodeId: z.string().optional().describe("Target node id for editText — must be an element/component node (get_page_model's block-annotated tree)"),
  runs: z
    .array(z.object({ text: z.string(), marks: z.array(z.enum(["strong", "em", "code"])).default([]), href: z.string().optional() }))
    .optional()
    .describe("Replacement rich-text runs for editText — see text-run-edit.mjs"),
  token: z.string().optional().describe("CSS custom-property name for setDesignToken, e.g. --color-primary (no --var()/calc() wrapping)"),
  tokenValue: z.string().optional().describe("New value for setDesignToken"),
```

- [ ] **Step 4: Compute and attach `inverse` in `applySetAttr`**

In `server/component-structure-edit.mjs`, modify `applySetAttr` (all three return branches):

```js
function applySetAttr(file, source, byId, component) {
  const { nodeId, name, value } = component;
  if (typeof nodeId !== "string" || typeof name !== "string") {
    return refuse("invalid-input", "set-attr requires component.nodeId and component.name");
  }
  const node = byId.get(nodeId);
  if (!node || node.span[0] == null || node.span[1] == null) {
    return refuse("no-match", "no node found at the given id — the file may have changed");
  }
  if (node.kind !== "element" && node.kind !== "component" && node.kind !== "slot") {
    return refuse("invalid-input", `set-attr requires a tag-shaped node (element/component/slot), got kind=${node.kind}`);
  }
  const existing = node.attrs.find((a) => a.name === name);
  const inverse = { op: "setProp", component: { path: file, nodeId, name, value: existing ? existing.value : null } };

  if (value === null || value === undefined) {
    if (!existing) return refuse("no-match", `node has no attribute "${name}" to remove`);
    let start = existing.span[0];
    while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
    if (start > 0 && source[start - 1] === "\n") start--;
    return { file, range: { start, end: existing.span[1] }, replacement: "", inverse };
  }

  if (existing) {
    return { file, range: { start: existing.span[0], end: existing.span[1] }, replacement: `${name}="${escapeAttr(value)}"`, inverse };
  }
  const lastAttr = node.attrs[node.attrs.length - 1];
  const insertAt = lastAttr ? lastAttr.span[1] : node.span[0] + 1 + (node.tag?.length ?? 0);
  return { file, range: { start: insertAt, end: insertAt }, replacement: ` ${name}="${escapeAttr(value)}"`, inverse };
}
```

- [ ] **Step 5: Run to verify Step 1's tests pass**

Run: `npx vitest run tests/component-structure-edit.test.ts -t "inverse"`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the failing test for `deleteBlock`'s inverse (raw re-insertion)**

Append to `tests/component-structure-edit.test.ts`:

```ts
it("deleteBlock's inverse is a raw insertBlock reconstructing the exact removed markup", async () => {
  const source = `---\n---\n<main><p id="keep">a</p><p id="gone">b</p></main>\n`;
  const { byId, rootId } = await indexSource(source);
  const main = [...byId.values()].find((n) => n.tag === "main")!;
  const gone = [...byId.values()].find((n) => n.tag === "p" && n.attrs.some((a) => a.name === "id" && a.value === "gone"))!;
  const goneIndex = main.childIds.indexOf(gone.id);
  const result = await resolveComponentStructure(projectRoot, {
    op: "deleteBlock",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: gone.id },
  });
  expect(result.inverse.op).toBe("insertBlock");
  expect(result.inverse.component.parentId).toBe(main.id);
  expect(result.inverse.component.index).toBe(goneIndex);
  expect(result.inverse.component.node).toEqual({ kind: "raw", markup: `<p id="gone">b</p>` });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run tests/component-structure-edit.test.ts -t "deleteBlock"`
Expected: FAIL — `result.inverse` undefined.

- [ ] **Step 8: Add `raw` handling to `buildMarkup` and attach `deleteBlock`'s inverse in `applyRemoveNode`**

Find `buildMarkup(nodeSpec)` (the function `applyInsertNode` calls to synthesize markup for
`element`/`component`/`slot`) and add a `raw` branch as its first check:

```js
function buildMarkup(nodeSpec) {
  if (nodeSpec.kind === "raw") return nodeSpec.markup;
  // ...existing element/component/slot branches unchanged...
}
```

In `applyRemoveNode`, capture the exact removed markup and parent/index before building the
replacement string, and attach `inverse` to all three return points:

```js
function applyRemoveNode(file, source, byId, rootId, component) {
  const { nodeId } = component;
  if (typeof nodeId !== "string") {
    return refuse("invalid-input", "remove-node requires component.nodeId");
  }
  const node = byId.get(nodeId);
  if (!node) return refuse("no-match", "no node found at the given id — the file may have changed");
  if (node.parentId === null) return refuse("invalid-input", "cannot remove the component's root");

  let spans;
  try {
    spans = resolveAllSpans(byId, rootId, source);
  } catch (err) {
    if (!(err instanceof SpanResolutionError)) throw err;
    return refuse("no-match", "could not lexically re-locate the node's true source span without trusting compiler offsets — refusing rather than risking corruption");
  }
  const span = spans.get(nodeId);
  if (!span) {
    return refuse("no-match", "could not lexically re-locate the node's true source span without trusting compiler offsets — refusing rather than risking corruption");
  }

  const parent = byId.get(node.parentId);
  const removedIndex = parent.childIds.indexOf(nodeId);
  const inverse = {
    op: "insertBlock",
    component: { path: file, parentId: node.parentId, index: removedIndex, node: { kind: "raw", markup: source.slice(span[0], span[1]) } },
  };

  let start = span[0];
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  if (start > 0 && source[start - 1] === "\n") start--;

  const withoutNode = source.slice(0, start) + source.slice(span[1]);

  const removedComponentNames = collectComponentTags(byId, nodeId);
  if (removedComponentNames.length === 0) {
    return { file, range: { start: 0, end: source.length }, replacement: withoutNode, inverse };
  }

  const fmMatch = withoutNode.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    return { file, range: { start: 0, end: source.length }, replacement: withoutNode, inverse };
  }
  const [whole, open, fmBody] = fmMatch;
  const fmStart = fmMatch.index;
  const fmBodyStart = fmStart + open.length;
  let newFmBody = fmBody;
  for (const name of removedComponentNames) {
    newFmBody = pruneImportIfUnused(newFmBody, withoutNode.slice(fmStart + whole.length), name).source;
  }
  const rewritten = withoutNode.slice(0, fmBodyStart) + newFmBody + withoutNode.slice(fmBodyStart + fmBody.length);
  return { file, range: { start: 0, end: source.length }, replacement: rewritten, inverse };
}
```

Note: `deleteBlock`'s inverse deliberately does **not** re-add a pruned component import — if the
removed subtree was the last usage of a component, its raw markup on reinsertion won't have a
matching import either. This is a known, documented v1 gap (flag it in Task 8's golden-test
coverage note rather than silently special-casing it): round-tripping a `deleteBlock` whose
subtree was the sole user of an import needs the reinserted `raw` markup's tag re-detected and its
import re-added, which duplicates `applyInsertNode`'s component-import logic against a `raw` blob.
Out of scope for this slice; the round-trip test in Task 8 should cover this gap explicitly with
a `.skip`-and-comment or an assertion of the current (import-less) behavior, not silence.

- [ ] **Step 9: Run to verify Step 6's test passes**

Run: `npx vitest run tests/component-structure-edit.test.ts -t "deleteBlock"`
Expected: PASS

- [ ] **Step 10: Write the failing test for `insertBlock`'s inverse (post-edit id resolution)**

Append to `tests/component-structure-edit.test.ts`:

```ts
it("insertBlock's inverse is a deleteBlock targeting the newly created node's post-edit id", async () => {
  const source = `---\n---\n<main></main>\n`;
  const { byId, rootId } = await indexSource(source);
  const main = [...byId.values()].find((n) => n.tag === "main")!;
  const result = await resolveComponentStructure(projectRoot, {
    op: "insertBlock",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), parentId: main.id, index: 0, node: { kind: "element", tag: "p" } },
  });
  expect(result.inverse.op).toBe("deleteBlock");
  // Re-parse the RESULT and confirm the inverse's nodeId actually resolves to the inserted <p>.
  const rewritten = result.replacement; // whole-file replacement per the {start:0,end:len} range
  const { byId: newById } = await indexSource(rewritten);
  const target = newById.get(result.inverse.component.nodeId);
  expect(target?.tag).toBe("p");
});
```

- [ ] **Step 11: Run to verify it fails**

Run: `npx vitest run tests/component-structure-edit.test.ts -t "insertBlock's inverse"`
Expected: FAIL — `result.inverse` undefined.

- [ ] **Step 12: Compute `insertBlock`'s inverse by re-indexing the rewritten source**

Modify `applyInsertNode` to compute the inverse after building `rewritten`/`withNode` (whichever
is the final returned replacement), by locating the inserted node's fresh id via
`resolveAllSpans` over the NEW source, matched against the known insertion offset (adjusted for
any frontmatter growth from a newly-added import):

```js
async function computeInsertInverse(file, finalSource, insertAtInFinalSource) {
  const { ast } = await parse(finalSource, { position: true });
  const { byId: newById, rootId: newRootId } = buildTemplateNodeIndex(ast, finalSource);
  let newSpans;
  try {
    newSpans = resolveAllSpans(newById, newRootId, finalSource);
  } catch {
    return null; // best-effort: if relocation fails, ship no inverse rather than a wrong one
  }
  for (const [id, span] of newSpans) {
    if (span[0] === insertAtInFinalSource) {
      return { op: "deleteBlock", component: { path: file, nodeId: id } };
    }
  }
  return null;
}

function applyInsertNode(file, source, byId, rootId, component) {
  // ...existing validation and `insertAt`/`markup`/`withNode` computation unchanged...

  if (nodeSpec.kind !== "component") {
    return { file, range: { start: 0, end: source.length }, replacement: withNode, __insertAt: insertAt, __final: withNode };
  }

  const fmMatch = withNode.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) {
    const importLine = `import ${nodeSpec.tag} from "${importSpecifier(file, nodeSpec.componentPath)}";\n`;
    const rewritten = `---\n${importLine}---\n${withNode}`;
    return { file, range: { start: 0, end: source.length }, replacement: rewritten, __insertAt: insertAt + `---\n${importLine}---\n`.length, __final: rewritten };
  }
  const [, open, fmBody] = fmMatch;
  const fmBodyStart = fmMatch.index + open.length;
  const { source: newFmBody, added } = ensureImport(fmBody, { localName: nodeSpec.tag, specifier: importSpecifier(file, nodeSpec.componentPath) });
  const rewritten = withNode.slice(0, fmBodyStart) + newFmBody + withNode.slice(fmBodyStart + fmBody.length);
  const importShift = added ? newFmBody.length - fmBody.length : 0;
  return { file, range: { start: 0, end: source.length }, replacement: rewritten, __insertAt: insertAt + importShift, __final: rewritten };
}
```

Then, in `resolveComponentStructure`'s `insert-node`/`insertBlock` dispatch (the switch
statement), await the inverse computation and strip the internal `__insertAt`/`__final` fields
before returning:

```js
    case "insert-node":
    case "insertBlock": {
      const result = applyInsertNode(relPath, source, byId, rootId, component);
      if (result.refused) return result;
      const { __insertAt, __final, ...rest } = result;
      const inverse = await computeInsertInverse(relPath, __final, __insertAt);
      return inverse ? { ...rest, inverse } : rest;
    }
```

(`resolveComponentStructure` is already `async` — Task 3's `loadFresh` awaits `parse`, so no
signature change is needed here, just the added `await`.)

- [ ] **Step 13: Run to verify Step 10's test passes**

Run: `npx vitest run tests/component-structure-edit.test.ts -t "insertBlock's inverse"`
Expected: PASS

- [ ] **Step 14: Write the failing test for `moveBlock`'s inverse, then implement it the same way**

Append to `tests/component-structure-edit.test.ts`:

```ts
it("moveBlock's inverse moves the node back to its original parent/index", async () => {
  const source = `---\n---\n<main><section id="from"><p id="m">x</p></section><section id="to"></section></main>\n`;
  const { byId } = await indexSource(source);
  const p = [...byId.values()].find((n) => n.attrs.some((a) => a.name === "id" && a.value === "m"))!;
  const to = [...byId.values()].find((n) => n.attrs.some((a) => a.name === "id" && a.value === "to"))!;
  const from = [...byId.values()].find((n) => n.attrs.some((a) => a.name === "id" && a.value === "from"))!;
  const result = await resolveComponentStructure(projectRoot, {
    op: "moveBlock",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: p.id, newParentId: to.id, newIndex: 0 },
  });
  const { byId: newById } = await indexSource(result.replacement);
  const movedBack = newById.get(result.inverse.component.nodeId);
  expect(movedBack?.attrs.some((a) => a.name === "id" && a.value === "m")).toBe(true);
  const newFromParent = [...newById.values()].find((n) => n.attrs.some((a) => a.name === "id" && a.value === "from"));
  expect(result.inverse.component.newParentId).toBe(newFromParent!.id);
  expect(result.inverse.component.newIndex).toBe(0);
});
```

Implement analogously to Step 12: `applyMoveNode` already computes `rewritten`; add the same
`computeInsertInverse`-style re-indexing, except the target op is `"moveBlock"` and the
`newParentId` is the ORIGINAL parent's id **as it exists in the re-parsed post-move tree** (find
it by matching the moved node's un-moved sibling context — simplest robust approach: before the
move, record the original parent's own resolved span-start in `source`; after the move, re-index
`rewritten` and find the node whose resolved span starts at that same offset, adjusted for the
net length delta the splice introduced before that offset). Follow the exact "resolve identity
via `resolveAllSpans` over the fresh parse, never via id reuse" discipline Step 12 established.

- [ ] **Step 15: Run the full structure-edit suite**

Run: `npx vitest run tests/component-structure-edit.test.ts`
Expected: PASS, all prior tests (non-inverse) still green.

- [ ] **Step 16: Wire `patcher.mjs` to route the four new op names**

`patcher.mjs` dispatches by checking `COMPONENT_STRUCTURE_OPS.has(edit.op)` (imported from
`apply-edit-schema.mjs`) before calling `resolveComponentStructure`. Since Step 3 already added
the four new names to that same `Set`, confirm (do not duplicate) that `patcher.mjs`'s existing
branch reads the Set rather than hardcoding the four legacy op strings — if it hardcodes them,
replace the hardcoded check with `COMPONENT_STRUCTURE_OPS.has(edit.op)`.

- [ ] **Step 17: Add manifest-aware resolution to `insertBlock`'s `manifestBlock` field**

In `resolveComponentStructure`, before dispatching to `applyInsertNode`, resolve `manifestBlock`
if present:

```js
    case "insert-node":
    case "insertBlock": {
      let effectiveComponent = component;
      if (component.manifestBlock) {
        const manifest = loadBlockManifest(projectRoot);
        const entry = indexManifestByName(manifest).get(component.manifestBlock);
        if (!entry) return refuse("no-match", `no block named "${component.manifestBlock}" in blocks.manifest.json`);
        effectiveComponent = {
          ...component,
          node: { kind: "component", tag: entry.export, componentPath: entry.path, slotName: component.node?.slotName },
        };
      }
      const result = applyInsertNode(relPath, source, byId, rootId, effectiveComponent);
      // ...rest as in Step 12...
    }
```

Add the corresponding import at the top of `component-structure-edit.mjs`:

```js
import { loadBlockManifest, indexManifestByName } from "./block-manifest.mjs";
```

- [ ] **Step 18: Write the failing test for `manifestBlock` resolution, then confirm it passes**

Append to `tests/component-structure-edit.test.ts`:

```ts
it("insertBlock resolves manifestBlock to the registered component's tag/path", async () => {
  writeFileSync(join(projectRoot, "blocks.manifest.json"), JSON.stringify({
    schemaVersion: "anglesite-block-manifest/1",
    modules: [{ path: "src/components/Testimonial.astro", export: "Testimonial", name: "Testimonial" }],
  }));
  const source = `---\n---\n<main></main>\n`;
  const { byId } = await indexSource(source);
  const main = [...byId.values()].find((n) => n.tag === "main")!;
  const result = await resolveComponentStructure(projectRoot, {
    op: "insertBlock",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), parentId: main.id, index: 0, manifestBlock: "Testimonial" },
  });
  expect(result.replacement).toContain("<Testimonial");
  expect(result.replacement).toContain(`import Testimonial from`);
});
```

Run: `npx vitest run tests/component-structure-edit.test.ts -t "manifestBlock"`
Expected: PASS once Step 17 lands.

- [ ] **Step 19: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add server/apply-edit-schema.mjs server/component-structure-edit.mjs server/patcher.mjs tests/component-structure-edit.test.ts
git commit -m "feat(server): invertible insertBlock/moveBlock/deleteBlock/setProp ops"
```

---

## Task 5: Dispatcher — stamp `inverse.component.baseVersion` after the write

**Files:**
- Modify: `server/apply-edit-dispatcher.mjs`
- Test: `tests/apply-edit-dispatcher-component-structure.test.ts` (existing file — append)

**Interfaces:**
- Consumes: `inverse` field from Task 4's resolvers (unstamped — no `baseVersion`).
- Produces: the `edit-applied` response content now includes `inverse` (fully stamped, ready to
  send back through `apply_edit` unmodified) whenever the resolved edit carried one. This is the
  field the app's `NSUndoManager` registration (spec §8.2) and the engine's ops log consume.

- [ ] **Step 1: Write the failing test**

Append to `tests/apply-edit-dispatcher-component-structure.test.ts`:

```ts
it("stamps inverse.component.baseVersion with the post-write content hash", async () => {
  const source = `---\n---\n<div id="a" title="old">x</div>\n`;
  writeFileSync(join(projectRoot, "src/pages/index.astro"), source);
  const { byId } = await indexSource(source);
  const divId = [...byId.values()].find((n) => n.tag === "div")!.id;
  const response = await applyEdit(projectRoot, {
    id: "1", path: "src/pages/index.astro", op: "setProp",
    component: { path: "src/pages/index.astro", baseVersion: fileVersion(source), nodeId: divId, name: "title", value: "new" },
  }, { onApplied: () => {} });
  const payload = JSON.parse(response.content[0].text);
  const written = readFileSync(join(projectRoot, "src/pages/index.astro"), "utf-8");
  expect(payload.inverse.component.baseVersion).toBe(fileVersion(written));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/apply-edit-dispatcher-component-structure.test.ts -t "stamps inverse"`
Expected: FAIL — `payload.inverse` is `undefined` or missing `baseVersion`.

- [ ] **Step 3: Stamp the inverse in `apply-edit-dispatcher.mjs`**

Locate the block that already piggybacks a fresh `buildComponentModel` result onto
`COMPONENT_OPS` success responses (per the Explore report, this reads the just-written file and
folds it into the `edit-applied` payload). Add the inverse-stamping right alongside it, using the
same freshly-read post-write source:

```js
  if (resolution.inverse) {
    payload.inverse = {
      ...resolution.inverse,
      component: { ...resolution.inverse.component, baseVersion: fileVersion(writtenSource) },
    };
  }
```

(`writtenSource` here is whatever local variable the existing piggyback logic already reads post-
`atomicWrite` — reuse it, don't re-read the file a second time.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/apply-edit-dispatcher-component-structure.test.ts -t "stamps inverse"`
Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add server/apply-edit-dispatcher.mjs tests/apply-edit-dispatcher-component-structure.test.ts
git commit -m "feat(server): stamp inverse ops with the post-write content hash"
```

---

## Task 6: `editText` — rich-text run editing

**Files:**
- Create: `server/text-run-edit.mjs`
- Modify: `server/patcher.mjs` (dispatch `editText`)
- Test: `tests/text-run-edit.test.ts`

**Scope note (record explicitly — this is a deliberate v1 boundary, not an oversight):** per the
Global Constraints, this task covers **`.astro` template rich-text nodes only** — toggling
`strong`/`em`/`code`/`a` inline HTML around a target element's text content. It does **not**
cover Markdoc/markdown content-collection body text (`src/content/**/*.mdoc`); no markdown AST
tooling exists in this sidecar today (confirmed: no remark/mdast/micromark dependency anywhere),
and adding one is a separate, dependency-approval-gated slice. `patcher.mjs`'s existing
`resolveMdoc` text-search-and-replace remains the only markdown-body editing path until that
follow-up lands.

**Interfaces:**
- Consumes: `resolveAllSpans`, `SpanResolutionError`, `escapeAttr` (Task 4's exports from
  `component-structure-edit.mjs`); `fileVersion`.
- Produces: `resolveTextRuns(projectRoot, edit): Promise<{file,range,replacement,inverse} |
  {refused,reason,detail}>`, dispatched for `edit.op === "editText"`. Payload:
  `component: { path, baseVersion, textNodeId, runs: RichTextRun[] }` where `RichTextRun = {
  text: string, marks: ("strong"|"em"|"code")[], href?: string }` (already added to
  `componentEditSchema` in Task 4 Step 3).

- [ ] **Step 1: Write the failing test — toggling bold on a paragraph's text**

Create `tests/text-run-edit.test.ts` (mirror `component-structure-edit.test.ts`'s tmpdir
`beforeEach`/`afterEach` and `indexSource` helper):

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/text-run-edit.test.ts`
Expected: FAIL with "Cannot find module '../server/text-run-edit.mjs'"

- [ ] **Step 3: Write `server/text-run-edit.mjs`**

```js
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { parse } from "@astrojs/compiler";
import { fileVersion } from "./file-version.mjs";
import { buildTemplateNodeIndex } from "./component-node-index.mjs";
import { resolveAllSpans, SpanResolutionError, escapeAttr } from "./component-structure-edit.mjs";

function refuse(reason, detail) {
  return { refused: true, reason, detail };
}

function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MARK_TAGS = { strong: "strong", em: "em", code: "code" };

/** Serializes runs into the small honest inline set the spec allows (§4): strong, em, code,
 *  link. Marks nest in a fixed, deterministic order (code innermost) so round-tripping the
 *  same runs always produces byte-identical markup — required for the golden tests in Task 8. */
function serializeRuns(runs) {
  return runs
    .map(({ text, marks = [], href }) => {
      let out = escapeText(text);
      for (const mark of ["code", "em", "strong"]) {
        if (marks.includes(mark)) out = `<${MARK_TAGS[mark]}>${out}</${MARK_TAGS[mark]}>`;
      }
      if (href !== undefined) out = `<a href="${escapeAttr(href)}">${out}</a>`;
      return out;
    })
    .join("");
}

/** Reverses serializeRuns for exactly the shapes it produces — one run per top-level mark
 *  combination, used only to reconstruct the inverse from a node's ORIGINAL rendered content,
 *  not a general HTML-to-runs parser. Out of scope: nested/mixed structures a human hand-edit
 *  could introduce outside the editor — those fall back to a single unmarked run of the raw
 *  inner text (a safe, if blunt, inverse: applying it always yields valid honest markup, just
 *  not a byte-identical restoration of hand-authored HTML). */
function parseRunsBestEffort(innerHtml) {
  const m = innerHtml.match(/^(?:<a href="([^"]*)">)?(?:<strong>)?(?:<em>)?(?:<code>)?([\s\S]*?)(?:<\/code>)?(?:<\/em>)?(?:<\/strong>)?(?:<\/a>)?$/);
  if (m && m[0] === innerHtml) {
    const marks = [];
    if (innerHtml.includes("<strong>")) marks.push("strong");
    if (innerHtml.includes("<em>")) marks.push("em");
    if (innerHtml.includes("<code>")) marks.push("code");
    const text = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return [{ text, marks, ...(m[1] !== undefined ? { href: m[1] } : {}) }];
  }
  const text = innerHtml.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return [{ text, marks: [] }];
}

export async function resolveTextRuns(projectRoot, edit) {
  const { component } = edit;
  if (!component || typeof component !== "object") return refuse("invalid-input", "component payload is required for editText");
  const { path: relPath, baseVersion, textNodeId, runs } = component;
  if (typeof relPath !== "string" || !relPath.endsWith(".astro") || normalize(relPath).startsWith("..") || relPath.startsWith("/")) {
    return refuse("invalid-input", `not a project-relative .astro path: ${relPath}`);
  }
  if (typeof textNodeId !== "string" || !Array.isArray(runs)) {
    return refuse("invalid-input", "editText requires component.textNodeId and component.runs");
  }

  const absPath = join(projectRoot, relPath);
  let source;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (err) {
    return refuse("read-failed", `read ${relPath}: ${err.message}`);
  }
  if (fileVersion(source) !== baseVersion) return refuse("stale", `${relPath} changed since the model was fetched`);

  let ast;
  try {
    ({ ast } = await parse(source, { position: true }));
  } catch (err) {
    return refuse("parse-failed", `parse ${relPath}: ${err.message}`);
  }
  const { byId, rootId } = buildTemplateNodeIndex(ast, source);
  const node = byId.get(textNodeId);
  if (!node || node.kind !== "element") return refuse("no-match", "editText requires an element node id from get_page_model");

  let spans;
  try {
    spans = resolveAllSpans(byId, rootId, source);
  } catch (err) {
    if (!(err instanceof SpanResolutionError)) throw err;
    return refuse("no-match", "could not lexically re-locate the node's true source span without trusting compiler offsets — refusing rather than risking corruption");
  }
  const outer = spans.get(textNodeId);
  if (!outer) return refuse("no-match", "could not lexically re-locate the node's true source span");

  // Inner-content boundary: the open tag's end through the matching close tag's start. Both
  // are re-derived from the source text at the already-verified `outer` span rather than
  // trusted from the AST — same discipline as every other resolver in this module set.
  const openEnd = source.indexOf(">", outer[0]) + 1;
  const closeStart = source.lastIndexOf("<", outer[1] - 1);
  if (openEnd <= outer[0] || closeStart < openEnd) return refuse("no-match", "could not resolve the element's inner-content boundary");

  const originalInner = source.slice(openEnd, closeStart);
  const inverse = { op: "editText", component: { path: relPath, textNodeId, runs: parseRunsBestEffort(originalInner) } };
  const replacement = serializeRuns(runs);
  return { file: relPath, range: { start: openEnd, end: closeStart }, replacement, inverse };
}
```

- [ ] **Step 4: Run to verify all three tests pass**

Run: `npx vitest run tests/text-run-edit.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire `patcher.mjs` to dispatch `editText`**

In `server/patcher.mjs`, add `editText` to the priority-ordered dispatch chain (alongside the
existing component-structure/style/frontmatter branches):

```js
import { resolveTextRuns } from "./text-run-edit.mjs";
// ...
  if (edit.op === "editText") return resolveTextRuns(projectRoot, edit);
```

- [ ] **Step 6: Add an end-to-end stdio test**

Append to `tests/mcp-server.test.ts`:

```ts
it("editText replaces an element's inner content with re-serialized runs over stdio", async () => {
  mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
  const source = `---\n---\n<p id="t">Hello world</p>\n`;
  writeFileSync(join(tmpDir, "src", "pages", "index.astro"), source);
  const modelResult = await callTool(proc, "get_page_model", { path: "src/pages/index.astro" });
  const model = JSON.parse(modelResult.content[0].text);
  const p = model.tree.children.find((n: any) => n.tag === "p");
  const result = await callTool(proc, "apply_edit", {
    id: "1", path: "src/pages/index.astro", op: "editText",
    component: { path: "src/pages/index.astro", baseVersion: model.version, textNodeId: p.id, runs: [{ text: "Bye", marks: ["strong"] }] },
  });
  const payload = JSON.parse(result.content[0].text);
  expect(payload.inverse.op).toBe("editText");
  const written = readFileSync(join(tmpDir, "src", "pages", "index.astro"), "utf-8");
  expect(written).toContain("<strong>Bye</strong>");
});
```

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`

```bash
git add server/text-run-edit.mjs server/patcher.mjs server/apply-edit-schema.mjs tests/text-run-edit.test.ts tests/mcp-server.test.ts
git commit -m "feat(server): add editText rich-text run editing with inverse"
```

---

## Task 7: `setDesignToken` — global CSS custom-property editing

**Files:**
- Modify: `server/css-rule-index.mjs` (factor a baseOffset-free rule walk)
- Create: `server/design-token-edit.mjs`
- Modify: `server/patcher.mjs` (dispatch `setDesignToken`)
- Test: `tests/design-token-edit.test.ts`

**Scope note:** targets only the **light** `:root { }` block in `src/styles/global.css` — the
file's own comment documents that the existing app-side theme-apply flow "upserts only the
top-level `:root` block above and leaves [the dark-mode `@media` block] alone"; `setDesignToken`
matches that established convention rather than inventing dark-mode-aware contrast derivation,
which is out of scope for this slice.

**Interfaces:**
- Produces: `walkCssRules(cssText: string, baseOffset: number): CssRule[]` (extracted from
  `indexCssRules`, exported from `css-rule-index.mjs`, reused by both the Astro-scoped-style path
  and the new global-stylesheet path). `resolveDesignToken(projectRoot, edit): Promise<...>`,
  dispatched for `edit.op === "setDesignToken"`. Payload: `component: { path, baseVersion, token,
  tokenValue }` where `path` is always `"src/styles/global.css"` (validated, not inferred) and
  `token` must match `/^--[\w-]+$/`.

- [ ] **Step 1: Write the failing test — refactor safety net for `css-rule-index.mjs`**

Ensure the existing `tests/component-model.test.ts` scoped-style assertions (which exercise
`indexCssRules` indirectly through `buildComponentModel`) still pass unmodified after Step 2's
refactor — no new test needed here, this step is a regression guard on existing coverage. Note it
so the refactor step isn't skipped without running it.

- [ ] **Step 2: Extract `walkCssRules` in `css-rule-index.mjs`**

```js
import { parse as parseCss, generate, walk } from "css-tree";
import { offsetFromLineColumn } from "./component-node-index.mjs";

function span(loc, baseOffset) {
  if (!loc) return [null, null];
  return [baseOffset + loc.start.offset, baseOffset + loc.end.offset];
}

/** Span-precise CSS rule index for a raw CSS string, given the byte offset that string starts
 *  at within its owning file (0 for a whole standalone .css file). Shared by indexCssRules
 *  (Astro <style> elements) and design-token-edit.mjs (global.css :root) so both agree
 *  byte-for-byte on rule/declaration identity via the same css-tree walk. */
export function walkCssRules(cssText, baseOffset) {
  let cssAst;
  try {
    cssAst = parseCss(cssText, { positions: true, parseValue: false, parseAtrulePrelude: false });
  } catch {
    return [];
  }
  const rules = [];
  walk(cssAst, {
    visit: "Rule",
    enter(node) {
      const media = this.atrule && this.atrule.name === "media" && this.atrule.prelude ? generate(this.atrule.prelude).trim() : null;
      const declarations = [];
      node.block.children.forEach((decl) => {
        if (decl.type !== "Declaration") return;
        declarations.push({ property: decl.property, value: generate(decl.value).trim(), span: span(decl.loc, baseOffset) });
      });
      const blockSpan = span(node.block.loc, baseOffset);
      rules.push({
        selector: generate(node.prelude), preludeSpan: span(node.prelude.loc, baseOffset), media,
        span: span(node.loc, baseOffset), blockInner: [blockSpan[0] + 1, blockSpan[1] - 1], declarations,
      });
    },
  });
  return rules;
}

export function indexCssRules(styleElement, lineStarts) {
  const lang = (styleElement.attributes ?? []).find((a) => a.name === "lang")?.value;
  if (lang && lang.trim().toLowerCase() !== "css") return [];
  const textChild = (styleElement.children ?? []).find((c) => c.type === "text");
  if (!textChild?.value) return [];
  const baseOffset = offsetFromLineColumn(lineStarts, textChild.position?.start) ?? 0;
  return walkCssRules(textChild.value, baseOffset);
}
```

- [ ] **Step 3: Run to verify no regression**

Run: `npx vitest run tests/component-model.test.ts tests/component-structure-edit.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Write the failing test for `setDesignToken`**

Create `tests/design-token-edit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run tests/design-token-edit.test.ts`
Expected: FAIL with "Cannot find module '../server/design-token-edit.mjs'"

- [ ] **Step 6: Write `server/design-token-edit.mjs`**

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileVersion } from "./file-version.mjs";
import { walkCssRules } from "./css-rule-index.mjs";

const GLOBAL_CSS_PATH = "src/styles/global.css";
const TOKEN_RE = /^--[\w-]+$/;

function refuse(reason, detail) {
  return { refused: true, reason, detail };
}

export async function resolveDesignToken(projectRoot, edit) {
  const { component } = edit;
  if (!component || typeof component !== "object") return refuse("invalid-input", "component payload is required for setDesignToken");
  const { path: relPath, baseVersion, token, tokenValue } = component;
  if (relPath !== GLOBAL_CSS_PATH) return refuse("invalid-input", `setDesignToken only targets ${GLOBAL_CSS_PATH}`);
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return refuse("invalid-input", `not a CSS custom-property name: ${token}`);
  if (typeof tokenValue !== "string") return refuse("invalid-input", "setDesignToken requires component.tokenValue");

  const absPath = join(projectRoot, relPath);
  let source;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (err) {
    return refuse("read-failed", `read ${relPath}: ${err.message}`);
  }
  if (fileVersion(source) !== baseVersion) return refuse("stale", `${relPath} changed since it was last read`);

  const rules = walkCssRules(source, 0);
  // The light palette only: the FIRST top-level `:root` rule not nested inside any @media —
  // matches the file's own documented convention (see this task's Scope note).
  const rootRule = rules.find((r) => r.selector.trim() === ":root" && r.media === null);
  if (!rootRule) return refuse("no-match", "no top-level :root rule found in global.css");
  const decl = rootRule.declarations.find((d) => d.property === token);
  if (!decl) return refuse("no-match", `:root has no declaration for ${token}`);

  const inverse = { op: "setDesignToken", component: { path: relPath, token, tokenValue: decl.value } };
  return { file: relPath, range: { start: decl.span[0], end: decl.span[1] }, replacement: `${token}: ${tokenValue}`, inverse };
}
```

- [ ] **Step 7: Run to verify all three tests pass**

Run: `npx vitest run tests/design-token-edit.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Wire `patcher.mjs` and confirm the dispatcher splices+writes+stamps correctly**

```js
import { resolveDesignToken } from "./design-token-edit.mjs";
// ...
  if (edit.op === "setDesignToken") return resolveDesignToken(projectRoot, edit);
```

Since `apply-edit-dispatcher.mjs`'s inverse-stamping (Task 5) reads `resolution.inverse`
generically — not gated on `COMPONENT_STRUCTURE_OPS` membership — confirm it applies to
`setDesignToken`'s resolution too. If Task 5's stamping code is scoped to
`COMPONENT_OPS.has(edit.op)`, widen that guard to `resolution.inverse != null` (any resolver that
returns one gets stamped), since `setDesignToken`/`editText` aren't in `COMPONENT_OPS`.

- [ ] **Step 9: Add an end-to-end stdio test**

Append to `tests/mcp-server.test.ts`:

```ts
it("setDesignToken patches global.css's :root and returns a stamped inverse over stdio", async () => {
  mkdirSync(join(tmpDir, "src", "styles"), { recursive: true });
  const css = `:root {\n  --color-primary: #2563eb;\n}\n`;
  writeFileSync(join(tmpDir, "src", "styles", "global.css"), css);
  const result = await callTool(proc, "apply_edit", {
    id: "1", path: "src/styles/global.css", op: "setDesignToken",
    component: { path: "src/styles/global.css", baseVersion: fileVersionOf(css), token: "--color-primary", tokenValue: "#111111" },
  });
  const payload = JSON.parse(result.content[0].text);
  expect(payload.inverse.component.tokenValue).toBe("#2563eb");
  const written = readFileSync(join(tmpDir, "src", "styles", "global.css"), "utf-8");
  expect(written).toContain("--color-primary: #111111");
});
```

(`fileVersionOf` — add a one-line local helper importing `fileVersion` from
`../server/file-version.mjs`, matching the file's existing import style.)

- [ ] **Step 10: Run the full suite and commit**

Run: `npm test`

```bash
git add server/css-rule-index.mjs server/design-token-edit.mjs server/patcher.mjs server/apply-edit-dispatcher.mjs tests/design-token-edit.test.ts tests/mcp-server.test.ts
git commit -m "feat(server): add setDesignToken global CSS custom-property editing"
```

---

## Task 8: Golden round-trip tests — op → source diff → re-parsed model

**Files:**
- Create: `tests/page-ops-roundtrip.test.ts`

**Interfaces:**
- Consumes every resolver from Tasks 4, 6, 7 plus `buildPageModel` (Task 3). No production code
  changes in this task — purely a test suite that exercises the full op/inverse contract
  end-to-end, per the spec's §10 testing requirement: "golden round-trip tests (op → source diff
  → re-parsed model) in the sidecar's node:test suite" (this repo's equivalent is Vitest, per the
  Global Constraints correction).

- [ ] **Step 1: Write the round-trip harness**

Create `tests/page-ops-roundtrip.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run to verify the three real round trips pass**

Run: `npx vitest run tests/page-ops-roundtrip.test.ts`
Expected: PASS (3 tests, 1 `.todo`)

- [ ] **Step 3: Add `insertBlock`/`moveBlock`/`deleteBlock` round trips**

Append three more `it(...)` blocks to the same file following the identical pattern, covering:
insert a `<p>` into `<main>` then delete it back out (byte-identical), and move a `<p>` between
two `<section>`s then move it back. Use the exact fixtures already written for these ops in Task
4 Steps 6/10/14 — copy the source strings and node lookups verbatim so the golden tests exercise
the same shapes the inverse-computation unit tests already proved correct in isolation.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add tests/page-ops-roundtrip.test.ts
git commit -m "test(server): golden op/inverse round-trip suite for the ops protocol"
```

---

## Task 9: Documentation and version bump

**Files:**
- Modify: `CLAUDE.md` (tool table, manual-testing section)
- Modify: `package.json`, `.claude-plugin/plugin.json`, `template/package.json` (version bump —
  via `bin/release.ts`, not hand-edited)

**Interfaces:** none — documentation and release-metadata only.

- [ ] **Step 1: Add the new tool and ops to `CLAUDE.md`'s tool table**

In `CLAUDE.md`'s **Tools** table (~line 30), add a row after `apply_edit`:

```markdown
| `get_page_model` | Parse a page `.astro` file into a block-annotated template tree — `get_component_model`'s shape plus a `block` descriptor on nodes that resolve against `blocks.manifest.json` |
```

Extend the `apply_edit` row's op-enum description to mention the new ops:

```markdown
| `apply_edit` | Patch source from an `ElementInfo` selector or a `component` payload. Closed op enum: `replace-text`, `replace-attr`, `replace-image-src`, `edit-style`, `apply-instruction`, the Component Editor ops, and the WYSIWYG block-editor ops `insertBlock`/`moveBlock`/`deleteBlock`/`setProp`/`editText`/`setDesignToken` — every block-editor op returns a computed `inverse` for host-side undo. Supports `dry_run`; responses are `edit-applied` / `edit-failed` (`server/apply-edit-schema.mjs`, `apply-edit-dispatcher.mjs`) |
```

- [ ] **Step 2: Document `blocks.manifest.json` briefly under "MCP server & the Anglesite-app host"**

Add one paragraph noting the file's purpose, location (project root), and that it's optional
(absent = no registered blocks), linking to `server/block-manifest-schema.mjs` as the source of
truth for its shape — mirroring how the existing section documents `content-types.mjs`.

- [ ] **Step 3: Run the manual testing snippet from `CLAUDE.md`'s "Testing changes manually" section**

Follow that section's existing instructions (spawn the server, send `initialize` +
`tools/call`), substituting `get_page_model` and one `apply_edit` block-op call, to confirm the
documented example actually works end-to-end before committing the doc change.

- [ ] **Step 4: Bump the version**

```bash
npx tsx bin/release.ts minor
```

Confirm it updated all three manifest files and created the `v*` git tag as `CLAUDE.md`'s Version
management section describes. **Do not push the tag** — that triggers the CI release workflow;
leave that decision to whoever merges the PR.

- [ ] **Step 5: Commit the docs (separately from the version bump, which `release.ts` already
  committed/tagged on its own)**

```bash
git add CLAUDE.md
git commit -m "docs: document get_page_model and the WYSIWYG block-editor ops"
```

---

## Self-Review Notes (from the writing-plans skill's required pass)

- **Spec coverage:** §3.2's op vocabulary (Task 4/6/7) ✓, invertibility hard requirement (Tasks
  4/5/6/7) ✓, `get_page_model`/host↔engine model shape (Task 3) ✓, content-hash versioning
  (reused `fileVersion` throughout, unchanged) ✓, theme block manifest as a CEM superset (Task 2)
  ✓, `custom-element` as a first-class block kind (§4.1) — **not covered**: this plan's manifest
  schema's `kind: "custom-element"` enum value is accepted by the schema (Task 2) but no resolver
  in Tasks 4/6/7 handles a custom-element block's insert/move/delete/prop differently from an
  Astro component's; flagged as an explicit follow-up rather than silently assumed identical,
  since the spec calls out real differences (shadow DOM piercing, `part()`/custom-property
  theming) that this slice's `.astro`-only resolvers don't address. Golden round-trip tests
  (spec §10) ✓ (Task 8, with one documented gap via `.todo`, not silence).
- **Placeholder scan:** no TODO/TBD strings outside the one explicit, justified `it.todo` in
  Task 8 (which documents a real, named gap rather than deferring unwritten logic).
- **Type consistency:** `PageModel`/`PageNode`/`BlockDescriptor` (Task 3) are consumed unchanged
  by Task 4's `insertBlock` manifest resolution (`BlockManifestModule` fields `path`/`export`/
  `name` match `indexManifestByPath`/`indexManifestByName`'s Task 2 definitions). `RichTextRun`
  (Task 4 Step 3's schema addition) matches Task 6's `resolveTextRuns` payload exactly. `inverse`
  is `{op, component}` consistently across Tasks 4/6/7 (never a bare op string or a different
  shape per resolver).

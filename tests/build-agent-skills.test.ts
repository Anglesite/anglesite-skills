import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSkill,
  classify,
  rewriteBody,
  buildFrontmatter,
  buildSkill,
  emitSkill,
  validateSkillName,
  validateSkill,
  inferCompatibility,
  renderIndex,
  relativeImports,
  parseToolList,
  formatToolList,
  specDescription,
  shellRootRefs,
} from "../bin/build-agent-skills.ts";

const ROOT = resolve(__dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const OUT_DIR = join(ROOT, "agent-skills");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

const sample = `---
name: demo
description: "Does a thing"
allowed-tools: Bash(npm run build), Read
disable-model-invocation: true
argument-hint: "[page /about]"
---

Body text.
`;

describe("parseSkill", () => {
  it("extracts frontmatter fields and reads allowed-tools raw", () => {
    const s = parseSkill(sample, VERSION);
    expect(s.name).toBe("demo");
    expect(s.description).toBe("Does a thing");
    expect(s.allowedTools).toBe("Bash(npm run build), Read");
    expect(s.argumentHint).toBe("[page /about]");
    expect(s.disableModelInvocation).toBe(true);
    expect(s.body.trim()).toBe("Body text.");
  });
});

describe("allowed-tools normalization", () => {
  it("splits comma lists without breaking entries that contain spaces", () => {
    expect(parseToolList("Bash(npm run build), Bash(git add *), Read")).toEqual([
      "Bash(npm run build)",
      "Bash(git add *)",
      "Read",
    ]);
  });

  it("accepts JSON/YAML flow arrays and space-separated lists", () => {
    expect(parseToolList('["Bash(npm install)", "Write"]')).toEqual(["Bash(npm install)", "Write"]);
    expect(parseToolList("Bash(git:*) Read")).toEqual(["Bash(git:*)", "Read"]);
  });

  it("emits the spec's space-separated string", () => {
    const fm = buildFrontmatter(parseSkill(sample, VERSION), VERSION);
    expect(fm).toMatch(/^allowed-tools: "Bash\(npm run build\) Read"$/m);
    expect(formatToolList(["Write", "Read"])).toBe("Write Read");
  });
});

describe("specDescription", () => {
  it("folds when_to_use into the spec description", () => {
    const s = parseSkill('---\nname: d\ndescription: "Deploy the site"\nwhen_to_use: "Use when publishing."\n---\n', VERSION);
    expect(specDescription(s)).toBe("Deploy the site. Use when publishing.");
    expect(buildFrontmatter(s, VERSION)).toMatch(/^description: "Deploy the site\. Use when publishing\."$/m);
  });

  it("flags a skill with no when_to_use", () => {
    expect(validateSkill(parseSkill(sample, VERSION)).some((e) => /when_to_use/.test(e))).toBe(true);
  });
});

describe("classify", () => {
  it("maps the plugin invocation flags to spec metadata", () => {
    expect(classify(parseSkill(sample, VERSION))).toBe("user-facing");
    expect(
      classify(parseSkill("---\nname: m\ndescription: x\nuser-invocable: false\n---\n", VERSION)),
    ).toBe("model-only");
    expect(classify(parseSkill("---\nname: b\ndescription: x\n---\n", VERSION))).toBe("both");
  });
});

describe("rewriteBody", () => {
  it("turns cross-skill references (bare, backticked, linked) into plain mentions", () => {
    const { body, crossSkillRefs } = rewriteBody(
      "Hand off to ${CLAUDE_PLUGIN_ROOT}/skills/donations/SKILL.md now. " +
        "Read `${CLAUDE_PLUGIN_ROOT}/skills/themes/SKILL.md`. " +
        "[buy-button](${CLAUDE_PLUGIN_ROOT}/skills/buy-button/SKILL.md)",
    );
    expect(body).toContain("the `donations` skill");
    expect(body).toContain("the `themes` skill");
    expect(body).toContain("the `buy-button` skill");
    expect(body).not.toContain("CLAUDE_PLUGIN_ROOT");
    // No nested code spans from the backticked form.
    expect(body).not.toMatch(/`the `/);
    expect(crossSkillRefs).toEqual(["buy-button", "donations", "themes"]);
  });

  it("rewrites doc references to references/<path> and records them", () => {
    const { body, references } = rewriteBody(
      "See [ADR](${CLAUDE_PLUGIN_ROOT}/docs/decisions/0001-astro.md) for details.",
    );
    expect(body).toContain("(references/docs/decisions/0001-astro.md)");
    expect(references).toContain("docs/decisions/0001-astro.md");
  });

  it("strips :symbol() annotations from collected paths but keeps them in prose", () => {
    const { body, references } = rewriteBody(
      "Use `${CLAUDE_PLUGIN_ROOT}/template/scripts/booking.ts:extractBrandColor()`.",
    );
    expect(references).toContain("template/scripts/booking.ts");
    expect(references).not.toContain("template/scripts/booking.ts:extractBrandColor()");
    expect(body).toContain("references/template/scripts/booking.ts:extractBrandColor()");
  });
});

describe("validation", () => {
  it("accepts spec-compliant names and rejects invalid ones", () => {
    expect(validateSkillName("buy-button")).toEqual([]);
    expect(validateSkillName("Buy-Button").length).toBeGreaterThan(0);
    expect(validateSkillName("-x").length).toBeGreaterThan(0);
    expect(validateSkillName("a--b").length).toBeGreaterThan(0);
  });

  it("flags out-of-range descriptions", () => {
    const long = parseSkill(`---\nname: x\ndescription: "${"a".repeat(1000)}"\nwhen_to_use: "${"b".repeat(100)}"\n---\n`, VERSION);
    expect(validateSkill(long).some((e) => /description/.test(e))).toBe(true);
  });
});

describe("buildFrontmatter", () => {
  it("emits only spec fields plus metadata, dropping plugin-only keys", () => {
    const fm = buildFrontmatter(parseSkill(sample, VERSION), VERSION);
    expect(fm).toMatch(/^name: demo$/m);
    expect(fm).toMatch(/^license: ISC$/m);
    expect(fm).toMatch(/^compatibility: /m);
    expect(fm).toMatch(/invocation: "user-facing"/);
    expect(fm).toMatch(/argument-hint: "\[page \/about\]"/);
    // Plugin-only top-level keys must not appear as frontmatter keys.
    expect(fm).not.toMatch(/^disable-model-invocation:/m);
    expect(fm).not.toMatch(/^user-invocable:/m);
  });
});

describe("inferCompatibility", () => {
  it("notes Cloudflare requirements when the skill uses wrangler", () => {
    const s = parseSkill("---\nname: d\ndescription: x\nallowed-tools: Bash(npx wrangler *)\n---\n", VERSION);
    expect(inferCompatibility(s)).toMatch(/Cloudflare/);
  });
});

describe("renderIndex", () => {
  it("lists install commands per skill", () => {
    const md = renderIndex([{ name: "seo", description: "SEO", invocation: "user-facing" }], VERSION);
    expect(md).toContain("npx skills add Anglesite/anglesite-skills/agent-skills/seo");
  });
});

// ---------------------------------------------------------------------------
// emitSkill — file writing, reference bundling, and warning paths
// ---------------------------------------------------------------------------

describe("emitSkill", () => {
  let pluginRoot: string;
  let outRoot: string;

  beforeEach(() => {
    const base = join(tmpdir(), `emit-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    pluginRoot = join(base, "plugin");
    outRoot = join(base, "out");
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(outRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(resolve(pluginRoot, ".."), { recursive: true, force: true });
  });

  const writePlugin = (rel: string, content: string) => {
    const p = join(pluginRoot, rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };

  const result = (name: string, references: string[]) => ({
    name,
    references,
    crossSkillRefs: [],
    warnings: [],
    skillMd: `---\nname: ${name}\ndescription: "x"\n---\n\nBody.\n`,
  });

  it("writes SKILL.md and bundles an existing reference file", () => {
    writePlugin("docs/decisions/0001-astro.md", "# ADR\n");
    const warnings = emitSkill(result("demo", ["docs/decisions/0001-astro.md"]), pluginRoot, outRoot);
    expect(existsSync(join(outRoot, "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(outRoot, "demo", "references/docs/decisions/0001-astro.md"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("resolves nested ${CLAUDE_PLUGIN_ROOT} references inside bundled markdown files instead of leaving them dangling", () => {
    // Two files, both with nested refs — guards against stale regex lastIndex.
    writePlugin("docs/a.md", "see ${CLAUDE_PLUGIN_ROOT}/docs/x.md\n");
    writePlugin("docs/b.md", "see ${CLAUDE_PLUGIN_ROOT}/docs/y.md\n");
    writePlugin("docs/x.md", "# X\n");
    writePlugin("docs/y.md", "# Y\n");
    const warnings = emitSkill(result("demo", ["docs/a.md", "docs/b.md"]), pluginRoot, outRoot);
    expect(warnings.filter((w) => w.startsWith("NESTED REF:"))).toHaveLength(0);
    expect(existsSync(join(outRoot, "demo", "references/docs/x.md"))).toBe(true);
    expect(existsSync(join(outRoot, "demo", "references/docs/y.md"))).toBe(true);
    const rewrittenA = readFileSync(join(outRoot, "demo", "references/docs/a.md"), "utf-8");
    expect(rewrittenA).toBe("see references/docs/x.md\n");
  });

  it("emits a MISSING REFERENCE warning when a nested reference's target doesn't exist", () => {
    writePlugin("docs/a.md", "see ${CLAUDE_PLUGIN_ROOT}/docs/missing.md\n");
    const warnings = emitSkill(result("demo", ["docs/a.md"]), pluginRoot, outRoot);
    expect(
      warnings.some((w) => w.startsWith("MISSING REFERENCE:") && w.includes("docs/missing.md")),
    ).toBe(true);
  });

  it("bundles the static parent directory for a placeholder (DYNAMIC) reference", () => {
    writePlugin("docs/smb/plumber.md", "# Plumber\n");
    writePlugin("docs/smb/florist.md", "# Florist\n");
    const warnings = emitSkill(result("demo", ["docs/smb/<BUSINESS_TYPE>.md"]), pluginRoot, outRoot);
    expect(existsSync(join(outRoot, "demo", "references/docs/smb/plumber.md"))).toBe(true);
    expect(existsSync(join(outRoot, "demo", "references/docs/smb/florist.md"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("emits DYNAMIC REF (not MISSING) when the placeholder parent is denylisted", () => {
    const warnings = emitSkill(result("demo", ["template/<path>"]), pluginRoot, outRoot);
    expect(warnings.some((w) => w.startsWith("DYNAMIC REF:") && w.includes("template/<path>"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("MISSING REFERENCE:"))).toBe(false);
  });

  it("emits MISSING REFERENCE for a non-placeholder path that does not exist", () => {
    const warnings = emitSkill(result("demo", ["scripts/does-not-exist.mjs"]), pluginRoot, outRoot);
    expect(warnings.some((w) => w.startsWith("MISSING REFERENCE:") && w.includes("does-not-exist"))).toBe(true);
  });

  it("bundles the transitive relative-import closure of a copied script", () => {
    writePlugin(
      "scripts/a/entry.mjs",
      "import { x } from './sibling.mjs';\nimport { y } from '../b/dep.mjs';\nexport const z = x + y;\n",
    );
    writePlugin("scripts/a/sibling.mjs", "export { s } from './deep.mjs';\nexport const x = 1;\n");
    writePlugin("scripts/a/deep.mjs", "export const s = 2;\n");
    writePlugin("scripts/b/dep.mjs", "export const y = 3;\n");
    const warnings = emitSkill(result("demo", ["scripts/a/entry.mjs"]), pluginRoot, outRoot);
    // Direct imports, a re-export chain, and a parent-directory import all land
    // in references/ at their plugin-root-relative paths.
    expect(existsSync(join(outRoot, "demo", "references/scripts/a/sibling.mjs"))).toBe(true);
    expect(existsSync(join(outRoot, "demo", "references/scripts/a/deep.mjs"))).toBe(true);
    expect(existsSync(join(outRoot, "demo", "references/scripts/b/dep.mjs"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("warns when a copied script imports a relative path that does not exist", () => {
    writePlugin("scripts/a/entry.mjs", "import { x } from './gone.mjs';\n");
    const warnings = emitSkill(result("demo", ["scripts/a/entry.mjs"]), pluginRoot, outRoot);
    expect(
      warnings.some((w) => w.startsWith("MISSING IMPORT:") && w.includes("scripts/a/gone.mjs")),
    ).toBe(true);
  });

  it("resolves extensionless imports to the source file", () => {
    writePlugin("scripts/entry.ts", "import tool from './lib/tool';\n");
    writePlugin("scripts/lib/tool.ts", "export default 1;\n");
    const warnings = emitSkill(result("demo", ["scripts/entry.ts"]), pluginRoot, outRoot);
    expect(existsSync(join(outRoot, "demo", "references/scripts/lib/tool.ts"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("bundles what a shell script reads through $PLUGIN_ROOT, even denylisted dirs", () => {
    writePlugin("scripts/scaffold.sh", 'TEMPLATE="${PLUGIN_ROOT}/template"\ncat "$PLUGIN_ROOT/package.json"\n');
    writePlugin("template/index.astro", "<h1>hi</h1>\n");
    writePlugin("package.json", "{}\n");
    const warnings = emitSkill(result("demo", ["scripts/scaffold.sh"]), pluginRoot, outRoot);
    expect(existsSync(join(outRoot, "demo", "references/template/index.astro"))).toBe(true);
    expect(existsSync(join(outRoot, "demo", "references/package.json"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("treats a placeholder ref as resolved when a script already bundled its parent", () => {
    writePlugin("scripts/update.sh", 'TEMPLATE="${PLUGIN_ROOT}/template"\n');
    writePlugin("template/index.astro", "<h1>hi</h1>\n");
    const warnings = emitSkill(result("demo", ["scripts/update.sh", "template/<path>"]), pluginRoot, outRoot);
    expect(warnings).toEqual([]);
  });

  it("follows relative imports of scripts inside a bundled directory", () => {
    writePlugin("scripts/dir/tool.mjs", "import { u } from '../shared/util.mjs';\n");
    writePlugin("scripts/shared/util.mjs", "export const u = 1;\n");
    const warnings = emitSkill(result("demo", ["scripts/dir"]), pluginRoot, outRoot);
    expect(existsSync(join(outRoot, "demo", "references/scripts/shared/util.mjs"))).toBe(true);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bundled scripts must be runnable: every relative import inside a bundled
// .mjs/.js/.ts file must resolve within the same references/ tree.
// ---------------------------------------------------------------------------

describe("shellRootRefs", () => {
  it("finds braced and bare $PLUGIN_ROOT paths", () => {
    expect(shellRootRefs('a="${PLUGIN_ROOT}/template"\nb=$PLUGIN_ROOT/package.json')).toEqual([
      "package.json",
      "template",
    ]);
  });
});

describe("bundled scripts resolve their relative imports", () => {
  const SCRIPT_EXT_RE = /\.(mjs|cjs|js|ts|mts)$/;

  const walkScripts = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walkScripts(p);
      return SCRIPT_EXT_RE.test(e.name) ? [p] : [];
    });
  };

  const bundledSkills = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && walkScripts(join(OUT_DIR, e.name, "references")).length > 0)
    .map((e) => e.name);

  it("covers the skills known to bundle scripts", () => {
    expect(bundledSkills).toEqual(expect.arrayContaining(["design-import", "import"]));
  });

  it.each(bundledSkills)("agent-skills/%s bundles the relative-import closure", (name) => {
    for (const file of walkScripts(join(OUT_DIR, name, "references"))) {
      const src = readFileSync(file, "utf-8");
      for (const spec of relativeImports(src)) {
        const target = resolve(join(file, ".."), spec);
        // TS ESM convention ('./x.js' → './x.ts') and extensionless specifiers.
        const candidates = [
          target,
          target.replace(/\.js$/, ".ts"),
          ...[".ts", ".mts", ".mjs", ".js"].map((ext) => target + ext),
          ...["index.ts", "index.mjs", "index.js"].map((f) => join(target, f)),
        ];
        expect(
          candidates.some((c) => existsSync(c)),
          `${file} imports ${spec} which is not bundled`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sync guard: committed agent-skills/<name>/SKILL.md must match a fresh build.
// (References are regenerated by the same build; CI also runs a git-diff check.)
// ---------------------------------------------------------------------------

describe("committed output is in sync", () => {
  const skillNames = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name);

  it("has a generated skill for every source skill", () => {
    for (const name of skillNames) {
      expect(existsSync(join(OUT_DIR, name, "SKILL.md")), `missing agent-skills/${name}`).toBe(true);
    }
  });

  it.each(skillNames)("agent-skills/%s/SKILL.md matches the transformer", (name) => {
    const src = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf-8");
    const expected = buildSkill(src, VERSION).skillMd;
    const committed = readFileSync(join(OUT_DIR, name, "SKILL.md"), "utf-8").replace(/\n$/, "");
    expect(committed).toBe(expected.replace(/\n$/, ""));
  });

  it.each(skillNames)("agent-skills/%s/SKILL.md meets the agentskills.io spec", (name) => {
    const md = readFileSync(join(OUT_DIR, name, "SKILL.md"), "utf-8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/)![1];
    const description = JSON.parse(fm.match(/^description: (.+)$/m)![1]) as string;
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description, "description must say when to use the skill").toMatch(/\bUse when\b/);
    const tools = fm.match(/^allowed-tools: (.+)$/m)?.[1];
    if (tools) {
      // A space-separated string — no list syntax, no commas between entries.
      const value = JSON.parse(tools) as string;
      expect(value.replace(/\([^)]*\)/g, "")).not.toMatch(/[,[\]]/);
    }
    expect(md.split("\n").length, "SKILL.md should stay within 500 lines").toBeLessThanOrEqual(500);
  });

  it("every generated SKILL.md is free of unresolved plugin variables", () => {
    for (const name of skillNames) {
      const md = readFileSync(join(OUT_DIR, name, "SKILL.md"), "utf-8");
      expect(md.includes("${CLAUDE_PLUGIN_ROOT}"), `${name} leaks CLAUDE_PLUGIN_ROOT`).toBe(false);
    }
  });
});

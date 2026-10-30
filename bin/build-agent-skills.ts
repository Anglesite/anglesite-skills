// Build spec-compliant Open Agent Skills (skills.sh / agentskills.io) from the
// Claude Code plugin sources in skills/.
//
// The plugin sources rely on plugin-specific machinery that the Agent Skills
// spec does not support:
//   - ${CLAUDE_PLUGIN_ROOT}/... references (no variable substitution in the spec)
//   - disable-model-invocation / user-invocable / argument-hint frontmatter
//   - cross-skill references to other SKILL.md files
//
// This transformer reads each skills/<name>/SKILL.md and emits a self-contained,
// spec-compliant skill into agent-skills/<name>/ — leaving the plugin sources
// untouched so the Claude Code plugin keeps working (coexistence).
//
// Usage:
//   npx tsx bin/build-agent-skills.ts            # build all skills
//   npx tsx bin/build-agent-skills.ts seo deploy # build only the named skills
//
// See docs/decisions/ for context and docs/dev/agent-skills.md for the output
// contract.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

const PLUGIN_VAR = "${CLAUDE_PLUGIN_ROOT}";

const AUTHOR = "David W. Keith";
const SOURCE = "https://github.com/Anglesite/anglesite-skills";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedSkill {
  name: string;
  description: string;
  /** Claude Code's `when_to_use` — folded into the spec description. */
  whenToUse?: string;
  allowedTools?: string;
  argumentHint?: string;
  disableModelInvocation: boolean;
  userInvocable?: boolean;
  body: string;
}

export type SkillClassification = "user-facing" | "model-only" | "both";

export interface BuildResult {
  name: string;
  /** Plugin-root-relative paths that were copied into references/. */
  references: string[];
  /** Other skills this skill referenced (rewritten to plain mentions). */
  crossSkillRefs: string[];
  /** Non-fatal problems worth surfacing. */
  warnings: string[];
  /** The emitted SKILL.md contents. */
  skillMd: string;
}

// ---------------------------------------------------------------------------
// parseSkill — read raw single-line frontmatter values verbatim
// ---------------------------------------------------------------------------

export function parseSkill(content: string, version: string): ParsedSkill {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  const raw = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  const unquote = (v?: string) =>
    v === undefined ? undefined : v.replace(/^["']|["']$/g, "");

  return {
    name: unquote(raw("name")) ?? "",
    description: unquote(raw("description")) ?? "",
    whenToUse: unquote(raw("when_to_use")),
    // allowed-tools is read raw — it contains commas and parens that would be
    // mangled by naive YAML round-tripping — and normalized at emit time.
    allowedTools: raw("allowed-tools"),
    argumentHint: unquote(raw("argument-hint")),
    disableModelInvocation: /^disable-model-invocation:\s*true\s*$/m.test(fm),
    userInvocable: /^user-invocable:\s*false\s*$/m.test(fm) ? false : undefined,
    body,
  };
}

/**
 * The spec has one `description` that must say what a skill does AND when to
 * use it (agents outside Claude Code see nothing else when deciding to load a
 * skill). Claude Code splits that into `description` + `when_to_use`, so join
 * them here.
 */
export function specDescription(skill: ParsedSkill): string {
  if (!skill.whenToUse) return skill.description;
  const what = /[.!?]$/.test(skill.description) ? skill.description : `${skill.description}.`;
  return `${what} ${skill.whenToUse}`;
}

export function classify(skill: ParsedSkill): SkillClassification {
  if (skill.userInvocable === false) return "model-only";
  if (skill.disableModelInvocation) return "user-facing";
  return "both";
}

// ---------------------------------------------------------------------------
// allowed-tools — normalize to the spec's space-separated string
// ---------------------------------------------------------------------------

/**
 * Split a plugin `allowed-tools` value into individual tool entries. Sources
 * use either a comma list (`Bash(npm run build), Read`) or a YAML/JSON flow
 * array (`["Bash(npm run build)", "Read"]`). Separators inside parentheses
 * belong to the entry, never split it.
 */
export function parseToolList(raw: string): string[] {
  const v = raw.trim();
  if (v.startsWith("[")) {
    try {
      return (JSON.parse(v) as unknown[]).map(String).map((t) => t.trim()).filter(Boolean);
    } catch {
      // Fall through to the tokenizer for non-JSON flow sequences.
    }
  }
  const inner = v.replace(/^\[|\]$/g, "");
  const tools: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) tools.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) tools.push(cur.trim());
  return tools.map((t) => t.replace(/^["']|["']$/g, ""));
}

/**
 * The spec defines `allowed-tools` as a space-separated string. Entries such
 * as `Bash(npm run build)` keep their inner spaces; parsers split on
 * whitespace outside parentheses, as Claude Code does.
 */
export function formatToolList(tools: string[]): string {
  return tools.join(" ");
}

// ---------------------------------------------------------------------------
// compatibility heuristic — surface real environment requirements
// ---------------------------------------------------------------------------

export function inferCompatibility(skill: ParsedSkill): string {
  const tools = skill.allowedTools ?? "";
  const base =
    "Designed for Claude Code / compatible agents operating inside an Anglesite project (Astro + Keystatic, Node >=22).";
  if (/wrangler|cloudflare/i.test(tools)) {
    return `${base} Deploy/provisioning steps require a Cloudflare account and Wrangler.`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Reference rewriting
// ---------------------------------------------------------------------------

const PLUGIN_VAR_RE = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
// Matches ${CLAUDE_PLUGIN_ROOT}/<path>, stopping at whitespace or markdown
// delimiters. Trailing sentence punctuation is trimmed afterwards.
const REF_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s)`\]"']+)/g;

/**
 * Normalize a captured reference into a copyable plugin-root-relative path:
 * drop any `file.ts:symbol()` annotation and trailing sentence punctuation.
 */
function cleanRefPath(p: string): string {
  return p.split(":")[0].replace(/[.,;]+$/, "");
}

/**
 * Rewrite a skill body for the Agent Skills format. Cross-skill references are
 * turned into plain mentions (each skill installs independently); every other
 * ${CLAUDE_PLUGIN_ROOT}/<path> reference is rewritten to references/<path> and
 * the path is recorded so the file can be bundled.
 */
export function rewriteBody(body: string): {
  body: string;
  references: string[];
  crossSkillRefs: string[];
} {
  const crossSkillRefs = new Set<string>();

  // 0. Backtick-wrapped cross-skill refs: `${ROOT}/skills/x/SKILL.md` -> the `x` skill
  //    (consume the surrounding backticks so we don't nest code spans).
  let out = body.replace(
    /`\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([a-z0-9-]+)\/SKILL\.md`/g,
    (_m, name: string) => {
      crossSkillRefs.add(name);
      return `the \`${name}\` skill`;
    },
  );

  // 1. Cross-skill markdown links: [label](${ROOT}/skills/x/SKILL.md) -> the `x` skill
  out = out.replace(
    /\[[^\]]*\]\(\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([a-z0-9-]+)\/SKILL\.md\)/g,
    (_m, name: string) => {
      crossSkillRefs.add(name);
      return `the \`${name}\` skill`;
    },
  );

  // 2. Bare cross-skill references: ${ROOT}/skills/x/SKILL.md -> the `x` skill
  out = out.replace(
    /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([a-z0-9-]+)\/SKILL\.md/g,
    (_m, name: string) => {
      crossSkillRefs.add(name);
      return `the \`${name}\` skill`;
    },
  );

  // 3. Collect the file paths to bundle (cleaned of :symbol() annotations),
  //    then rewrite the variable prefix in the prose. The prose keeps the full
  //    path text (incl. any :symbol() annotation); only the prefix changes.
  const references = new Set<string>();
  let m: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(out)) !== null) {
    references.add(cleanRefPath(m[1]));
  }
  out = out.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, "references/");
  // Any leftover bare ${CLAUDE_PLUGIN_ROOT} (without a path) -> references root.
  out = out.replace(PLUGIN_VAR_RE, "references");

  return {
    body: out,
    references: [...references].sort(),
    crossSkillRefs: [...crossSkillRefs].sort(),
  };
}

// ---------------------------------------------------------------------------
// Frontmatter emission
// ---------------------------------------------------------------------------

export function buildFrontmatter(skill: ParsedSkill, version: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${skill.name}`);
  // Quote description defensively (it may contain colons).
  lines.push(`description: ${JSON.stringify(specDescription(skill))}`);
  lines.push("license: ISC");
  lines.push(`compatibility: ${JSON.stringify(inferCompatibility(skill))}`);
  if (skill.allowedTools) {
    lines.push(`allowed-tools: ${JSON.stringify(formatToolList(parseToolList(skill.allowedTools)))}`);
  }
  lines.push("metadata:");
  lines.push(`  author: ${JSON.stringify(AUTHOR)}`);
  lines.push(`  version: ${JSON.stringify(version)}`);
  lines.push(`  source: ${JSON.stringify(SOURCE)}`);
  // Preserve the plugin's invocation intent as metadata (no spec equivalent).
  lines.push(`  invocation: ${JSON.stringify(classify(skill))}`);
  if (skill.argumentHint) {
    lines.push(`  argument-hint: ${JSON.stringify(skill.argumentHint)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validation (mirrors the agentskills.io spec rules)
// ---------------------------------------------------------------------------

export function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length < 1 || name.length > 64)
    errors.push(`name must be 1-64 chars (got ${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name))
    errors.push(`name "${name}" must be lowercase alphanumerics and hyphens only`);
  if (name.startsWith("-") || name.endsWith("-"))
    errors.push(`name "${name}" must not start or end with a hyphen`);
  if (name.includes("--"))
    errors.push(`name "${name}" must not contain consecutive hyphens`);
  return errors;
}

export function validateSkill(skill: ParsedSkill): string[] {
  const errors = validateSkillName(skill.name);
  const description = specDescription(skill);
  if (description.length < 1 || description.length > 1024)
    errors.push(`description must be 1-1024 chars (got ${description.length})`);
  if (!skill.whenToUse)
    errors.push("missing when_to_use — the spec description must say when to use the skill");
  return errors;
}

// ---------------------------------------------------------------------------
// buildSkill — produce the in-memory result for one skill
// ---------------------------------------------------------------------------

export function buildSkill(content: string, version: string): BuildResult {
  const skill = parseSkill(content, version);
  const warnings: string[] = [];

  for (const e of validateSkill(skill)) warnings.push(`INVALID: ${e}`);

  const { body, references, crossSkillRefs } = rewriteBody(skill.body);
  const frontmatter = buildFrontmatter(skill, version);
  const skillMd = `${frontmatter}\n${body}`;

  const lineCount = skillMd.split("\n").length;
  if (lineCount > 500) {
    warnings.push(
      `SKILL.md is ${lineCount} lines (>500 recommended) — consider splitting into references/`,
    );
  }

  return { name: skill.name, references, crossSkillRefs, warnings, skillMd };
}

// ---------------------------------------------------------------------------
// Relative-import walking — bundled scripts must be runnable, so every copied
// script file drags its relative-import closure into references/ with it.
// ---------------------------------------------------------------------------

const SCRIPT_FILE_RE = /\.(mjs|cjs|js|ts|mts)$/;

// import/export ... from './x' · side-effect import './x' · dynamic import('./x')
const RELATIVE_IMPORT_RES = [
  /(?:import|export)\s[^'"()]*?from\s*['"](\.[^'"]+)['"]/g,
  /import\s*['"](\.[^'"]+)['"]/g,
  /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];

/** Static relative import specifiers ('./x.mjs', '../y/z.mjs') in a script. */
export function relativeImports(source: string): string[] {
  const specs = new Set<string>();
  for (const re of RELATIVE_IMPORT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs].sort();
}

// Shell scripts locate plugin files through a PLUGIN_ROOT variable derived
// from their own path ($PLUGIN_ROOT/template, ${PLUGIN_ROOT}/package.json).
const SHELL_ROOT_REF_RE = /\$\{?PLUGIN_ROOT\}?\/([A-Za-z0-9_.\/-]+)/g;

/** Plugin-root-relative paths a shell script reads via $PLUGIN_ROOT. */
export function shellRootRefs(source: string): string[] {
  const refs = new Set<string>();
  SHELL_ROOT_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHELL_ROOT_REF_RE.exec(source)) !== null) {
    refs.add(m[1].replace(/\/+$/, ""));
  }
  return [...refs].sort();
}

/**
 * Resolve an import target the way Node/Vite would for this repo's sources:
 * exact path, the TS ESM convention ('./x.js' compiled from './x.ts'), then
 * extensionless specifiers ('./x' → x.ts / x.mjs / x.js / x/index.*).
 * Returns the input unchanged when nothing matches.
 */
function resolveImport(target: string): string {
  if (existsSync(target) && statSync(target).isFile()) return target;
  const candidates = [
    ...(target.endsWith(".js") ? [target.replace(/\.js$/, ".ts")] : []),
    ...[".ts", ".mts", ".mjs", ".js"].map((ext) => target + ext),
    ...["index.ts", "index.mjs", "index.js"].map((f) => join(target, f)),
  ];
  return candidates.find((c) => existsSync(c)) ?? target;
}

/** All script files under a path (the file itself, or a directory walk). */
function scriptFilesUnder(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return SCRIPT_FILE_RE.test(path) ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    scriptFilesUnder(join(path, e.name)),
  );
}

// ---------------------------------------------------------------------------
// emitSkill — write the result + bundled references to disk
// ---------------------------------------------------------------------------

// Top-level directories too large to bundle wholesale for a dynamic reference.
const NO_BULK_BUNDLE = new Set(["template"]);

/** A path segment is a placeholder if it's bracketed (<x>) or ALL_CAPS. */
function isPlaceholderSegment(seg: string): boolean {
  if (seg.includes("<") || seg.includes(">")) return true;
  const base = seg.replace(/\.[a-z0-9]+$/i, "");
  return /^[A-Z][A-Z0-9_]{2,}$/.test(base);
}

/** Static directory prefix before the first placeholder segment. */
function staticPrefix(path: string): string {
  const segs = path.split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (isPlaceholderSegment(seg)) break;
    out.push(seg);
  }
  // Drop a trailing non-placeholder filename so we keep only the directory.
  if (out.length === segs.length && /\.[a-z0-9]+$/i.test(out[out.length - 1])) {
    out.pop();
  }
  return out.join("/");
}

export function emitSkill(
  result: BuildResult,
  pluginRoot: string,
  outRoot: string,
): string[] {
  const warnings = [...result.warnings];
  const skillDir = join(outRoot, result.name);
  if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(join(skillDir, "SKILL.md"), result.skillMd.endsWith("\n") ? result.skillMd : result.skillMd + "\n");

  const bundled = new Set<string>();

  const dynamicRefs: string[] = [];

  /**
   * Resolve a ${CLAUDE_PLUGIN_ROOT}-relative reference (found either in the
   * top-level SKILL.md or inside a nested bundled doc) and bundle it.
   */
  function bundleRef(ref: string) {
    if (existsSync(join(pluginRoot, ref))) {
      copyInto(ref);
      return;
    }
    // Path doesn't exist verbatim. If it's a runtime-computed (placeholder)
    // path, bundle its static parent directory so the path resolves at runtime.
    // Deferred until everything else is bundled: a script may already have
    // pulled in that parent (update.sh bundles template/ for template/<path>).
    if (ref.split("/").some(isPlaceholderSegment)) {
      dynamicRefs.push(ref);
      return;
    }
    warnings.push(`MISSING REFERENCE: ${ref} (referenced but not found in plugin root)`);
  }

  function bundleDynamicRef(ref: string) {
    const prefix = staticPrefix(ref);
    if (prefix && isBundled(prefix)) return;
    if (prefix && !NO_BULK_BUNDLE.has(prefix) && existsSync(join(pluginRoot, prefix))) {
      copyInto(prefix);
    } else {
      warnings.push(
        `DYNAMIC REF: ${ref} left as references/${ref} (resolved at runtime; parent not bundled)`,
      );
    }
  }

  /** Whether relPath, or a directory containing it, is already bundled. */
  function isBundled(relPath: string): boolean {
    return [...bundled].some((b) => relPath === b || relPath.startsWith(`${b}/`));
  }

  function copyInto(relPath: string) {
    if (isBundled(relPath)) return;
    const src = join(pluginRoot, relPath);
    const dest = join(skillDir, "references", relPath);
    mkdirSync(dirname(dest), { recursive: true });
    const st = statSync(src);
    cpSync(src, dest, { recursive: st.isDirectory() });
    bundled.add(relPath);
    // Markdown reference files can themselves contain ${CLAUDE_PLUGIN_ROOT}
    // links (e.g. a skill's companion doc pointing at another plugin doc).
    // Rewrite those the same way the top-level SKILL.md body is rewritten,
    // and bundle whatever they point to, so the chain resolves standalone
    // instead of shipping a dangling variable reference.
    if (st.isFile() && relPath.endsWith(".md")) {
      const content = readFileSync(src, "utf-8");
      if (content.includes(PLUGIN_VAR)) {
        const { body: rewritten, references: nestedRefs } = rewriteBody(content);
        writeFileSync(dest, rewritten);
        for (const nestedRef of nestedRefs) bundleRef(nestedRef);
      }
    }
    // Shell scripts read plugin files through $PLUGIN_ROOT at runtime (e.g.
    // scaffold.sh copies $PLUGIN_ROOT/template); bundle those explicitly, even
    // directories NO_BULK_BUNDLE keeps out of placeholder resolution.
    if (st.isFile() && relPath.endsWith(".sh")) {
      for (const shellRef of shellRootRefs(readFileSync(src, "utf-8"))) {
        if (existsSync(join(pluginRoot, shellRef))) copyInto(shellRef);
        else warnings.push(`MISSING REFERENCE: ${relPath} reads $PLUGIN_ROOT/${shellRef} (not found)`);
      }
    }
    // Follow relative imports so bundled scripts stay runnable: references/
    // preserves the plugin-root-relative layout, so each import target lands
    // exactly where the importing file expects it.
    for (const scriptFile of scriptFilesUnder(src)) {
      const scriptRel = relative(pluginRoot, scriptFile);
      for (const spec of relativeImports(readFileSync(scriptFile, "utf-8"))) {
        const target = resolveImport(resolve(dirname(scriptFile), spec));
        const targetRel = relative(pluginRoot, target);
        if (targetRel.startsWith("..") || !existsSync(target)) {
          warnings.push(`MISSING IMPORT: ${scriptRel} imports ${spec} (${targetRel} not found)`);
          continue;
        }
        copyInto(targetRel);
      }
    }
  }

  for (const ref of result.references) {
    bundleRef(ref);
  }
  for (const ref of dynamicRefs) {
    bundleDynamicRef(ref);
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1]?.endsWith("build-agent-skills.ts") ||
  process.argv[1]?.endsWith("build-agent-skills.js");

if (isMain) {
  const root = resolve(import.meta.dirname ?? ".", "..");
  // Only skills/ is exported — deliberately NOT .claude/skills/, which holds
  // Claude-Code-native skills for developing this plugin (never shipped to end
  // users). Widening this glob would publish internal tooling to skills.sh.
  const skillsDir = join(root, "skills");
  const outRoot = join(root, "agent-skills");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;

  const only = process.argv.slice(2);
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .filter((n) => only.length === 0 || only.includes(n))
    .sort();

  if (only.length > 0 && names.length === 0) {
    console.error(`No matching skills for: ${only.join(", ")}`);
    process.exit(1);
  }

  mkdirSync(outRoot, { recursive: true });

  let totalWarnings = 0;
  const built: { name: string; description: string; invocation: SkillClassification }[] = [];
  for (const name of names) {
    const content = readFileSync(join(skillsDir, name, "SKILL.md"), "utf-8");
    const parsed = parseSkill(content, version);
    const result = buildSkill(content, version);
    const warnings = emitSkill(result, root, outRoot);
    built.push({ name, description: parsed.description, invocation: classify(parsed) });
    const refCount = result.references.length;
    const xCount = result.crossSkillRefs.length;
    console.log(
      `✓ ${name} — ${refCount} reference(s), ${xCount} cross-skill mention(s)${
        warnings.length ? `, ${warnings.length} warning(s)` : ""
      }`,
    );
    for (const w of warnings) {
      console.log(`    ⚠ ${w}`);
      totalWarnings++;
    }
  }

  // Regenerate the index only on a full build, so partial builds don't truncate it.
  if (only.length === 0) {
    writeFileSync(join(outRoot, "README.md"), renderIndex(built, version) + "\n");
  }

  console.log(
    `\nBuilt ${names.length} skill(s) into agent-skills/${
      totalWarnings ? ` (${totalWarnings} warning(s))` : ""
    }`,
  );
}

// ---------------------------------------------------------------------------
// renderIndex — agent-skills/README.md (generated)
// ---------------------------------------------------------------------------

export function renderIndex(
  skills: { name: string; description: string; invocation: SkillClassification }[],
  version: string,
): string {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [
    "<!-- Auto-generated by bin/build-agent-skills.ts — do not edit manually. -->",
    "",
    "# Anglesite — Open Agent Skills",
    "",
    `Spec-compliant [Agent Skills](https://agentskills.io) (skills.sh) generated from the`,
    "Anglesite Claude Code plugin. Each skill is self-contained: bundled reference",
    "material lives in its `references/` directory.",
    "",
    "> Generated — do not edit by hand. Edit the plugin sources in `skills/` and run",
    "> `npm run build:agent-skills`.",
    "",
    `**Version:** ${version} · **License:** ISC · ${sorted.length} skills`,
    "",
    "## Install",
    "",
    "Install with the skills.sh CLI — the whole collection, or one skill:",
    "",
    "```sh",
    "npx skills add Anglesite/anglesite-skills/agent-skills",
    "npx skills add Anglesite/anglesite-skills/agent-skills/<skill>",
    "```",
    "",
    "Always include the `agent-skills/` path: the repo's `skills/` directory holds the",
    "Claude Code plugin sources, which depend on `${CLAUDE_PLUGIN_ROOT}` and only run",
    "inside the plugin.",
    "",
    "> **Listing:** skills.sh has no submission step — its directory and",
    "> `npx skills find` are populated from the CLI's anonymous install telemetry for",
    "> public GitHub repos. A skill appears once it has been installed by path as above.",
    "",
    "## Skills",
    "",
    "| Skill | Install | Description |",
    "|---|---|---|",
  ];
  for (const s of sorted) {
    lines.push(
      `| \`${s.name}\` | \`npx skills add Anglesite/anglesite-skills/agent-skills/${s.name}\` | ${s.description} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

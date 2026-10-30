# Open Agent Skills export

Anglesite is distributed two ways from one source:

1. **Claude Code plugin** — the `skills/` tree, installed from the
   `Anglesite/anglesite-skills` marketplace.
2. **Open Agent Skills** — a spec-compliant ([agentskills.io](https://agentskills.io) /
   [skills.sh](https://www.skills.sh)) export under `agent-skills/`, installable with
   `npx skills add Anglesite/anglesite-skills/agent-skills/<skill>` (or
   `…/agent-skills` for the whole collection).

The two coexist. `skills/` is the **source of truth**; `agent-skills/` is **generated**
by `bin/build-agent-skills.ts` (`npm run build:agent-skills`) and committed so the
skills.sh CLI can resolve individual skills by path.

## Why a build step (not dual-format files)

The plugin sources depend on machinery the Agent Skills spec does not support, so a
single file cannot satisfy both formats:

| Plugin feature | Spec status | Transform |
|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}/...` references | not supported (no variable substitution) | rewritten to relative `references/<path>`; the referenced file is bundled |
| `disable-model-invocation`, `user-invocable` | not in spec | dropped from frontmatter; intent preserved as `metadata.invocation` |
| `argument-hint` | not in spec | moved to `metadata.argument-hint` |
| `when_to_use` | not in spec (the spec `description` must cover what *and* when) | appended to `description` |
| `allowed-tools` as a comma list or YAML array | spec wants one space-separated string | re-joined with single spaces; `Bash(npm run build)` keeps its inner spaces |
| `metadata.internal: true` (on every plugin source) | skills.sh discovery flag | not copied — the export is the discoverable copy |
| cross-skill links to other `SKILL.md` | no spec mechanism | rewritten to a plain mention (``the `x` skill``); each skill installs independently |

## What the transformer does

Per `skills/<name>/SKILL.md` it emits `agent-skills/<name>/`:

- **Frontmatter** normalized to the spec: `name`, `description` (source
  `description` + `when_to_use`), `license: ISC`, `compatibility` (Cloudflare/Node
  requirements inferred from `allowed-tools`), `allowed-tools` (space-separated), and a
  `metadata` block (author, version, source, invocation, argument-hint).
- **Body** rewritten: `${CLAUDE_PLUGIN_ROOT}/` → `references/`; cross-skill links →
  mentions; `file.ts:symbol()` annotations preserved in prose but stripped from the
  copied path.
- **`references/`** containing every bundled file, mirroring its plugin-root path
  (e.g. `references/docs/decisions/0003-...md`). Runtime-computed paths
  (`docs/smb/<BUSINESS_TYPE>.md`) bundle their static parent directory so the path
  resolves at runtime.
- **Relative JS imports are followed.** Every bundled script (`.mjs`/`.cjs`/`.js`/
  `.ts`/`.mts`) has its static relative imports (`import … from './x.mjs'`,
  `export … from`, side-effect and dynamic imports) walked transitively, and the
  whole closure is copied into `references/` at plugin-root-relative paths — so
  bundled scripts stay runnable in a standalone install. The TS ESM convention
  (`./x.js` importing a `./x.ts` source) is resolved. Imports that don't resolve
  inside the plugin root are surfaced as `MISSING IMPORT` build warnings. Extensionless
  specifiers (`./x` → `x.ts` / `x.mjs` / `x/index.ts`) resolve like Node/Vite would.
- **Shell scripts' `$PLUGIN_ROOT` reads are followed.** `scaffold.sh` and `update.sh`
  locate files via `${PLUGIN_ROOT}/template` and `$PLUGIN_ROOT/package.json`; every
  bundled `.sh` is scanned for those and the targets are bundled, so `start`, `update`,
  `import`, `convert`, and `design-import` ship the full `template/` and can scaffold
  standalone. (`template/` is otherwise kept out of placeholder bundling.)

`agent-skills/README.md` is a generated index with per-skill install commands.

## Discovery: why plugin sources are marked internal

The skills.sh CLI scans a repo's `skills/` and `.claude/skills/` directories, so a bare
`npx skills add Anglesite/anglesite-skills` would otherwise offer the raw plugin
sources (dangling `${CLAUDE_PLUGIN_ROOT}` references) and the internal `serena` dev
skill. Every plugin source therefore carries `metadata.internal: true`, which hides it
from normal discovery; with nothing found in the standard locations the CLI falls back
to a recursive search and lists the 56 `agent-skills/` entries instead. Naming a skill
explicitly (`--skill start`) makes the CLI include internal skills again and it then
picks the shallower plugin source — so documented commands always include the
`agent-skills/` path. Keep the `metadata.internal` block when adding a skill.

## Validation

`bin/build-agent-skills.ts` validates names and descriptions against the spec rules
(name: 1–64 chars, lowercase/hyphens, no leading/trailing/consecutive hyphens;
description: 1–1024 chars, and a `when_to_use` must exist) and prints warnings. `tests/build-agent-skills.test.ts`
unit-tests the transforms, asserts the committed `agent-skills/*/SKILL.md` matches a
fresh build, and checks every generated skill against the spec (description says when
to use it, space-separated `allowed-tools`, ≤500 lines). CI
(`.github/workflows/test.yml`) re-runs the build and fails if `git status` shows any
change — modified or new — under `agent-skills/`.

## Keeping it in sync

Never edit `agent-skills/` by hand. Edit `skills/` and run:

```sh
npm run build:agent-skills   # all skills
npx tsx bin/build-agent-skills.ts seo deploy   # a subset (index not regenerated)
```

## Known limitations / follow-ups

- **Duplicated bundles.** Skills that read a business-type guide
  (`docs/smb/<BUSINESS_TYPE>.md`) bundle the whole `docs/smb/` catalog (688 KB), and
  five skills bundle `template/` (2.3 MB). The checked-out tree is ~22 MB, but git
  stores identical files once, so the copies add almost nothing to a clone; each
  installed skill stays self-contained. Not bundling would break standalone installs.
- **Nested references (resolved for markdown).** Bundled `.md` docs (e.g. `import`'s
  `docs/import/wix.md`, `deploy`'s `skills/deploy/domain-setup.md`) may contain their
  own `${CLAUDE_PLUGIN_ROOT}` references. The build rewrites those the same way it
  rewrites the top-level `SKILL.md` body and transitively bundles whatever they point
  to, so the chain resolves standalone. A `MISSING REFERENCE` warning fires if the
  nested target doesn't exist in the plugin root. Non-markdown bundled files are only
  scanned for relative imports (scripts) and `$PLUGIN_ROOT` reads (shell).
- **Body length.** Long skills keep each step's heading in `SKILL.md` and move the
  detail into companion docs next to it (`skills/import/blog-posts.md`,
  `skills/deploy/web-analytics.md`, …), which bundle like any other reference. The
  test suite fails a generated `SKILL.md` over 500 lines.
- **`template/.mcp.json`** points at the plugin's MCP server; in a standalone install
  that server isn't present, so the click-to-edit tools are plugin-only.
- **Listing.** skills.sh has no submission step: its directory and `npx skills find`
  are populated from the CLI's anonymous install telemetry for public GitHub repos.
  Anglesite shows up once someone installs from `Anglesite/anglesite-skills/agent-skills`.

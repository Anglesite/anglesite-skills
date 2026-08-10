# Anglesite — Development Context

Anglesite is a Claude plugin that scaffolds and manages websites for small businesses. It works with Claude Cowork (non-technical site owners, GUI) and Claude Code (developers, CLI). It generates Astro + Keystatic sites deployed to Cloudflare Workers (Static Assets, via the `@astrojs/cloudflare` adapter).

**Version:** 1.9.0

> Don't hand-edit or remove that line: `bin/release.ts` rewrites it on every bump and **throws** if it's missing, and `tests/release.test.ts` asserts it matches `package.json`.

## Agent instruction hierarchy

Two levels of agent instructions exist — do not confuse them:

| File | Audience | Purpose |
|---|---|---|
| **This file** (root `CLAUDE.md`) | Plugin developers | Building and maintaining the plugin itself |
| `template/CLAUDE.md` | Claude Code / Cowork users | Webmaster guide + Claude Code commands |

## How it works

1. User installs the plugin from the `Anglesite/anglesite` marketplace (or `claude --plugin-dir .` for development). The marketplace catalog (`.claude-plugin/marketplace.json`) lives in this same repo alongside the plugin manifest.
2. `/anglesite:start` runs `scripts/scaffold.sh` to copy `template/` to the user's project
3. Start skill proceeds with discovery interview, design, and tool installation
4. All other skills (`/anglesite:deploy`, `/anglesite:check`, etc.) execute in the user's working directory

## MCP server & the Anglesite-app host

`server/` is also a public integration surface: the native macOS host `Anglesite/Anglesite-app` embeds this plugin and drives its click-to-edit UI through this MCP server. Treat the schema and transport below as a contract — change them plugin-side first, then coordinate with the app (see ADR-0023 and `docs/dev/mac-app-design.md`).

**Tools** (registered by `buildServer(projectRoot)` in `server/index-tools.mjs`):

| Tool | Purpose |
|---|---|
| `add_annotation` / `list_annotations` / `resolve_annotation` | Pin, list, and resolve feedback notes anchored to page elements |
| `apply_edit` | Patch source from an `ElementInfo` selector or a `component` payload. Closed op enum: `replace-text`, `replace-attr`, `replace-image-src`, `edit-style`, `apply-instruction`, the Component Editor ops, and the WYSIWYG block-editor ops `insertBlock`/`moveBlock`/`deleteBlock`/`setProp`/`editText`/`setDesignToken` — every block-editor op returns a computed `inverse` for host-side undo. Supports `dry_run`; responses are `edit-applied` / `edit-failed` (`server/apply-edit-schema.mjs`, `apply-edit-dispatcher.mjs`) |
| `get_page_model` | Parse a page `.astro` file into a block-annotated template tree — `get_component_model`'s shape plus a `block` descriptor on nodes that resolve against `blocks.manifest.json` |
| `undo_edit` | Revert the last applied edit via the `anglesite/edits` history branch |
| `list_content` | Enumerate pages/posts |
| `create_page` / `create_post` | Scaffold new content with frontmatter |

**Transport.** The server is transport-agnostic. `server/index.mjs` connects it over **stdio** by default. Set `ANGLESITE_MCP_TRANSPORT=http` to use the **Streamable HTTP** transport (`server/http-server.mjs`, endpoint `/mcp`, session via `Mcp-Session-Id`) with `ANGLESITE_MCP_HOST` / `ANGLESITE_MCP_PORT` — used by the app's container runtimes. The server prints an `Anglesite MCP listening on …` readiness line the host waits for.

**Runtime.** The app vendors a pinned Node (`Anglesite-app/scripts/node-version.txt`) to execute `server/*.mjs`; the CI test matrix should track it so the shipped interpreter is exercised here.

**Typed content.** `server/content-types.mjs` is a mirror of the app's `ContentTypeRegistry.swift` — the Swift file is the source of truth. Change it there first, then mirror the change here.

**Block manifest.** `blocks.manifest.json` (project root) registers Astro components and custom elements that the WYSIWYG block editor can insert, move, and edit (via `insertBlock`, `moveBlock`, `deleteBlock`, `setProp`, `editText`, `setDesignToken` ops in `apply_edit`). The file is optional — absence means no registered blocks. See `server/block-manifest-schema.mjs` for the source of truth on structure, validation, and prop-editor kinds.

## Skills reference

`docs/dev/skill-registry.md` is generated from skill frontmatter (`npm run registry`) — read it for the current inventory rather than maintaining a second copy here.

Two visibility classes, set in each skill's frontmatter:

- **User-facing** — invoked as `/anglesite:<name>`; frontmatter has `disable-model-invocation: true`.
- **Model-only** — called programmatically by other skills; frontmatter has `user-invocable: false`.

## Editing guidelines

- **Template files** go in `template/` — they're copied to the user's project during `/anglesite:start`
- **Skills** go in `skills/` — they reference user project files (relative) and plugin files (`${CLAUDE_PLUGIN_ROOT}`)
- **Tool permissions** are in each skill's `allowed-tools` frontmatter (not `settings.json`)
- **Cross-skill references** use `${CLAUDE_PLUGIN_ROOT}/skills/skill-name/SKILL.md`
- **The end user is non-technical.** Skills are their primary interface. Changes should not require CLI knowledge.
- **Cross-platform.** Template scripts detect macOS/Linux/Windows via `scripts/platform.ts`. Never use platform-specific commands (`sips`, `pfctl`, `dscacheutil`, `osascript`, `open`, `sed -i ""`) without a cross-platform alternative or guard.
- **Privacy and security are non-negotiable.** The deploy skill scans for PII, exposed tokens, third-party scripts, and Keystatic admin routes.
- **PII is collected on-demand, not upfront.** Names, emails, phone numbers, and addresses are PII. Skills should not prompt for them speculatively during setup or onboarding. Prompt only when a specific output requires the field — frame the question by the use case ("What name should appear on the copyright line?" not "What's your name?") and save the answer to `.site-config` so other skills don't re-ask. The canonical example is `OWNER_NAME`: `start` no longer collects it; consumer skills (`print`, `convert`'s footer, About-page work, h-card / IndieAuth) prompt for it themselves and write back. See "On-demand owner name" in `skills/start/SKILL.md` and follow the same pattern when adding new fields.
- **Reference docs** go in `docs/` at the plugin root — skills read them via `${CLAUDE_PLUGIN_ROOT}/docs/`.
- **Site-specific docs** go in `template/docs/` — these are scaffolded to the user's project and updated per-site.
- **Documentation must stay in sync.** Update docs when you change behavior.
- **MCP-first for Cloudflare provisioning.** When a skill provisions Cloudflare resources (KV namespaces, R2 buckets, D1 databases, Hyperdrive configs, Workers), prefer the Cloudflare MCP tools (`mcp__cloudflare__kv_namespace_create`, `mcp__cloudflare__kv_namespace_get`, `mcp__cloudflare__kv_namespaces_list`, etc.) over shelling out to `npx wrangler …`. The MCP path returns the resource id directly, so the skill can write the binding into the relevant `worker/*-wrangler.toml` itself — no copy-paste, no terminal-output parsing, and no human-readable prompt the owner has to interpret. Always document a `wrangler` CLI fallback for offline / no-MCP environments, and add the relevant `mcp__cloudflare__*` tools to the skill's `allowed-tools` frontmatter.

## Key decisions

| Decision | Why |
|---|---|
| Claude Code Plugin | Marketplace distribution, versioning, namespace isolation |
| Astro (not Next/Nuxt) | Zero client JS by default, best for static content sites |
| Keystatic (not headless CMS) | Local `.mdoc` files, no external API dependency |
| Cloudflare Workers + Static Assets (not Vercel/Netlify) | Free, fast, `wrangler deploy` from CLI; `@astrojs/cloudflare` adapter |
| GitHub (not GitLab) | `gh` CLI browser OAuth is simplest for non-technical users; private repos free |
| Vanilla CSS | No build-time framework overhead, custom properties for theming |
| Industry tools first | Recommend purpose-built solutions (Square, Shopify, Clio, etc.) over generic databases |
| Edge A/B testing (not client-side) | Build-time variants + Worker-entry edge assignment = zero flicker, static-site compatible |
| Pagefind (not Algolia/Orama) | Build-time index, ~6 KB JS, no external service, first-class Astro integration |
| On-device `fm` as optional authoring accelerator | Free/private/offline drafts — alt text (incl. imported images via `ai-alt`) and inbox triage; never in the deployed site, always falls back to Claude (ADR-0021) |

Full ADRs are in `docs/decisions/`.

## Version management

Versions must stay in sync across three files:
- `package.json`
- `.claude-plugin/plugin.json`
- `template/package.json`

Use `bin/release.ts` to bump all at once. It creates a git tag (`v*`) which triggers the CI release workflow.

The MCP server version reported on `initialize` is **not** a fourth file to bump — `server/index-tools.mjs` reads it from `.claude-plugin/plugin.json` at startup, so it tracks the plugin version automatically.

## Distribution channels

Anglesite ships two ways from one source — they coexist:

1. **Claude Code plugin** — the `skills/` tree, installed from the `Anglesite/anglesite` marketplace.
2. **Open Agent Skills** — a spec-compliant ([agentskills.io](https://agentskills.io) / [skills.sh](https://www.skills.sh)) export under `agent-skills/`, installable with `npx skills add Anglesite/anglesite/agent-skills/<skill>`.

`skills/` is the source of truth. `agent-skills/` is **generated** by `npm run build:agent-skills` (`bin/build-agent-skills.ts`) and committed so the skills.sh CLI can resolve skills by path. The transformer rewrites `${CLAUDE_PLUGIN_ROOT}` references into bundled `references/`, drops plugin-only frontmatter (`disable-model-invocation`, `user-invocable`, `argument-hint`) into spec `metadata`, and converts cross-skill links into plain mentions. **Never edit `agent-skills/` by hand** — edit `skills/` and rebuild. CI (`.github/workflows/test.yml`) fails if the export is stale. See `docs/dev/agent-skills.md` for the full contract and known limitations.

## CI/CD

`.github/workflows/test.yml` runs on PRs and pushes to `main`; `release.yml` runs on `v*` tags.

When the app bumps its pinned Node version (`Anglesite-app/scripts/node-version.txt`), update the test matrix to match.

## Testing changes manually

```sh
mkdir /tmp/test-site
zsh scripts/scaffold.sh /tmp/test-site
cd /tmp/test-site
npm install
npm run dev
```

## Security hooks

The `hooks/hooks.json` defines a PreToolUse hook that runs `scripts/pre-deploy-check.sh` before any Bash tool use. It enforces four mandatory scans before deploying to `main`:
1. **PII scan** — emails, phone numbers (configurable allowlists via `PII_EMAIL_ALLOW` and `PII_PHONE_ALLOW` in `.site-config`)
2. **Token scan** — exposed API keys and secrets
3. **Third-party script scan** — blocks unauthorized external JS
4. **Keystatic admin route scan** — ensures CMS admin is not publicly exposed

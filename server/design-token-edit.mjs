/**
 * `setDesignToken` resolver — patches a single CSS custom-property declaration inside the
 * LIGHT `:root { }` block of a scaffolded site's `src/styles/global.css`. Deliberately leaves
 * the dark-mode `@media (prefers-color-scheme: dark)` block untouched, matching that file's
 * own documented convention (the app-side theme-apply flow already only upserts the top-level
 * `:root` block and leaves the dark-mode block alone).
 *
 * Unlike the component-structure/text resolvers, this one has no async parse step —
 * `walkCssRules` (css-rule-index.mjs) runs css-tree's `parse`, which is synchronous — so there's
 * no yield point between the baseVersion check below and this function returning that a
 * concurrent write could land in. It stays `async` for signature consistency with the sibling
 * resolvers `patcher.mjs` dispatches to, not because it needs to await anything.
 */
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
  if (!component || typeof component !== "object") {
    return refuse("invalid-input", "component payload is required for setDesignToken");
  }
  const { path: relPath, baseVersion, token, tokenValue } = component;
  if (relPath !== GLOBAL_CSS_PATH) {
    return refuse("invalid-input", `setDesignToken only targets ${GLOBAL_CSS_PATH}`);
  }
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return refuse("invalid-input", `not a CSS custom-property name: ${token}`);
  }
  if (typeof tokenValue !== "string") {
    return refuse("invalid-input", "setDesignToken requires component.tokenValue");
  }

  const absPath = join(projectRoot, relPath);
  let source;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (err) {
    return refuse("read-failed", `read ${relPath}: ${err.message}`);
  }
  if (fileVersion(source) !== baseVersion) {
    return refuse("stale", `${relPath} changed since it was last read`);
  }

  const rules = walkCssRules(source, 0);
  // The light palette only: the FIRST top-level `:root` rule not nested inside any @media —
  // matches the file's own documented convention (see this module's header comment).
  const rootRule = rules.find((r) => r.selector.trim() === ":root" && r.media === null);
  if (!rootRule) return refuse("no-match", "no top-level :root rule found in global.css");
  const decl = rootRule.declarations.find((d) => d.property === token);
  if (!decl) return refuse("no-match", `:root has no declaration for ${token}`);

  const inverse = { op: "setDesignToken", component: { path: relPath, token, tokenValue: decl.value } };
  return {
    file: relPath,
    range: { start: decl.span[0], end: decl.span[1] },
    replacement: `${token}: ${tokenValue}`,
    inverse,
  };
}

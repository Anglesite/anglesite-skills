// `editText` — rich-text run editing for .astro template elements (WYSIWYG in-canvas text
// editing). Replaces an element's inner content with re-serialized "honest" inline HTML:
// strong/em/code/a href, nested in a fixed order so round-tripping the same runs is
// byte-identical. Deliberately does NOT touch Markdoc/markdown content-collection body text
// (src/content/**/*.mdoc) — no markdown AST parser exists in this sidecar (no remark/mdast/
// micromark dependency), and adding one is a separate, dependency-approval-gated slice.
// patcher.mjs's `resolveMdoc` text-search-and-replace remains the only markdown-body editing
// path until that follow-up lands.
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { parse } from "@astrojs/compiler";
import { fileVersion } from "./file-version.mjs";
import { buildTemplateNodeIndex } from "./component-node-index.mjs";
import { resolveAllSpans, SpanResolutionError, escapeAttr, scanTagOpen } from "./component-structure-edit.mjs";

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

function unescapeText(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Inverts escapeAttr (component-structure-edit.mjs): that escapes "&" first, then '"', so
// undoing it runs in the opposite order — unescape "&quot;" back to '"' first, THEN "&amp;"
// back to "&" — otherwise a literal "&quot;" that was itself escaped from a source "&amp;quot;"
// would double-unescape.
function unescapeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Reverses serializeRuns for exactly the shapes it produces — one run whose marks/href nest in
 *  serializeRuns' own fixed order (a outermost, then strong, then em, then code innermost, each
 *  independently optional) — used only to reconstruct the inverse from a node's ORIGINAL
 *  rendered content, not a general HTML-to-runs parser. Peels each wrapper only when the
 *  *entire* remaining string is exactly `<tag>...</tag>` (a plain prefix/suffix check, safe
 *  because `escapeText`/`escapeAttr` always turn any literal "<"/">" in real run content into
 *  entities, so a raw "<" can only appear here as serializeRuns' own structural markup — never
 *  as user text). Out of scope: multi-run content (the normal shape after a first edit) and any
 *  other nested/mixed structure a human hand-edit could introduce outside the editor — after
 *  peeling every wrapper this function recognizes, anything with tag delimiters STILL left over
 *  falls back to a single unmarked run of the fully-stripped text (a safe, if blunt, inverse:
 *  applying it always yields valid honest markup, just not a byte-identical restoration). */
function parseRunsBestEffort(innerHtml) {
  let rest = innerHtml;
  let href;
  if (rest.startsWith('<a href="') && rest.endsWith("</a>")) {
    const closeQuote = rest.indexOf('">', 9);
    if (closeQuote !== -1) {
      href = unescapeAttr(rest.slice(9, closeQuote));
      rest = rest.slice(closeQuote + 2, rest.length - 4);
    }
  }

  const marks = [];
  for (const mark of ["strong", "em", "code"]) {
    const open = `<${mark}>`;
    const close = `</${mark}>`;
    if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= open.length + close.length) {
      marks.push(mark);
      rest = rest.slice(open.length, rest.length - close.length);
    }
  }

  if (!/[<>]/.test(rest)) {
    return [{ text: unescapeText(rest), marks, ...(href !== undefined ? { href } : {}) }];
  }
  return [{ text: unescapeText(innerHtml.replace(/<[^>]+>/g, "")), marks: [] }];
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
  // Tag-shaped kinds only — same set `set-attr` (component-structure-edit.mjs) treats
  // uniformly, since the open/close-tag boundary scan below doesn't depend on which of these
  // three it is. A block editor's blocks are frequently component instances (e.g.
  // `<Badge>New</Badge>`), so excluding "component"/"slot" would refuse a common real case.
  if (!node || !["element", "component", "slot"].includes(node.kind)) {
    return refuse("no-match", "editText requires an element/component/slot node id from get_page_model");
  }

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
  //
  // The open tag's end is found via `scanTagOpen` (component-structure-edit.mjs) rather than a
  // naive `indexOf(">", ...)` — a stray literal ">" inside a quoted attribute value (e.g.
  // `<p title="a>b">`) would otherwise fool a naive forward scan into landing INSIDE the
  // attribute list, corrupting the splice. `scanTagOpen` skips quoted values and brace-delimited
  // attribute expressions the same way `resolveAllSpans` already does when it first resolved
  // `outer` itself.
  const tagInfo = scanTagOpen(source, outer[0]);
  if (!tagInfo) return refuse("no-match", "could not resolve the element's opening tag");
  const openEnd = tagInfo.end;
  const closeStart = source.lastIndexOf("<", outer[1] - 1);
  // Also refuses cleanly for a self-closing/void element (e.g. `<img ... />`, `<br>`) — there's
  // no real close tag to search for, so `closeStart` lands back at (or before) `outer[0]`,
  // which is always < `openEnd`.
  if (closeStart < openEnd) return refuse("no-match", "could not resolve the element's inner-content boundary");

  const originalInner = source.slice(openEnd, closeStart);
  const inverse = { op: "editText", component: { path: relPath, textNodeId, runs: parseRunsBestEffort(originalInner) } };
  const replacement = serializeRuns(runs);
  return { file: relPath, range: { start: openEnd, end: closeStart }, replacement, inverse };
}

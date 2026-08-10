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

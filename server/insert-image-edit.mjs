import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parse } from "@astrojs/compiler";
import { buildTemplateNodeIndex } from "./component-node-index.mjs";
import { resolveAllSpans, resolveInsertionOffset, escapeAttr, SpanResolutionError } from "./component-structure-edit.mjs";
import { pathToAstroCandidates } from "./patcher.mjs";

function refuse(reason, detail) {
  return { refused: true, reason, detail };
}

/**
 * Picks where a brand-new image should land inside a page's template: as the last child of the
 * page's sole wrapping Layout component when there is exactly one (every template page wraps its
 * content in one Layout, e.g. `<BaseLayout>...</BaseLayout>` — appending at the literal AST
 * fragment root would insert the <img> as a SIBLING of that wrapper, outside the rendered page
 * content), falling back to the fragment root itself for anything else (zero or multiple
 * top-level nodes, or a single non-component top-level node).
 */
function resolveImageParent(byId, rootId) {
  const root = byId.get(rootId);
  if (root.childIds.length === 1) {
    const only = byId.get(root.childIds[0]);
    if (only && only.kind === "component") return only;
  }
  return root;
}

/**
 * Resolves `insert-image` to a single-file patch that appends a new `<img>` inside the target
 * page's content. Unlike `insert-node`/`resolveComponentStructure`, this is NOT a component-payload
 * op — it addresses its target via `edit.path` (a URL page path, like `replace-image-src`), has no
 * `baseVersion` staleness guard (there is no prior `get_component_model` fetch to go stale against
 * — the file is always read fresh here), and takes no `component.parentId`/`index` — the insertion
 * point is always "append inside this page's content," resolved fresh from the current file.
 *
 * @param {string} projectRoot
 * @param {{ path: string, value: { src: string, srcset?: string, alt?: string } }} edit
 */
export async function resolveInsertImage(projectRoot, edit) {
  const candidates = pathToAstroCandidates(projectRoot, edit.path);
  if (candidates.length === 0) {
    return refuse("no-match", `no .astro file found for path ${edit.path}`);
  }
  if (candidates.length > 1) {
    return refuse("ambiguous", `${candidates.length} .astro files match path ${edit.path}`);
  }
  const absPath = candidates[0];

  let source;
  try {
    source = readFileSync(absPath, "utf-8");
  } catch (err) {
    return refuse("write-failed", `read ${edit.path}: ${err.message}`);
  }

  let ast;
  try {
    ({ ast } = await parse(source, { position: true }));
  } catch (err) {
    return refuse("parse-failed", `parse ${edit.path}: ${err.message}`);
  }

  const { byId, rootId } = buildTemplateNodeIndex(ast, source);
  const parent = resolveImageParent(byId, rootId);

  let spans;
  try {
    spans = resolveAllSpans(byId, rootId, source);
  } catch (err) {
    if (!(err instanceof SpanResolutionError)) throw err;
    return refuse(
      "no-match",
      "could not lexically re-locate the page's structure without trusting compiler offsets — refusing rather than risking corruption",
    );
  }

  const insertAt = resolveInsertionOffset(byId, rootId, spans, source, parent, parent.childIds.length, undefined);
  if (insertAt == null) {
    return refuse("no-match", "could not resolve an insertion point in the page");
  }

  const { src, srcset, alt } = edit.value;
  const attrs = [`src="${escapeAttr(src)}"`];
  if (srcset) attrs.push(`srcset="${escapeAttr(srcset)}"`);
  attrs.push(`alt="${escapeAttr(alt ?? "")}"`);
  const markup = `\n  <img ${attrs.join(" ")} />`;
  const replacement = source.slice(0, insertAt) + markup + source.slice(insertAt);

  return { file: relative(projectRoot, absPath), range: { start: 0, end: source.length }, replacement };
}

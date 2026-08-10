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

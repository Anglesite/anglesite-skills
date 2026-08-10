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

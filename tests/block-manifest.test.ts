import { describe, it, expect } from "vitest";
import { blockManifestSchema } from "../server/block-manifest-schema.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBlockManifest, indexManifestByPath, indexManifestByName, BlockManifestError } from "../server/block-manifest.mjs";

describe("blockManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const result = blockManifestSchema.safeParse({
      schemaVersion: "anglesite-block-manifest/1",
      modules: [
        {
          path: "src/components/Hcard.astro",
          export: "Hcard",
          kind: "astro",
          name: "Business Card",
          description: "Name, photo, and contact details as an h-card.",
          icon: null,
          propEditors: [{ prop: "name", editor: "text" }],
          slots: [],
          placement: { allowedParents: null },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown propEditor kind", () => {
    const result = blockManifestSchema.safeParse({
      schemaVersion: "anglesite-block-manifest/1",
      modules: [
        {
          path: "src/components/Hcard.astro",
          export: "Hcard",
          name: "Business Card",
          propEditors: [{ prop: "name", editor: "not-a-real-editor" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("loadBlockManifest", () => {
  it("returns an empty manifest when blocks.manifest.json is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "anglesite-manifest-"));
    try {
      const manifest = loadBlockManifest(dir);
      expect(manifest.modules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads, validates, and indexes a real manifest file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anglesite-manifest-"));
    try {
      writeFileSync(
        join(dir, "blocks.manifest.json"),
        JSON.stringify({
          schemaVersion: "anglesite-block-manifest/1",
          modules: [{ path: "src/components/Hcard.astro", export: "Hcard", name: "Business Card" }],
        }),
      );
      const manifest = loadBlockManifest(dir);
      expect(indexManifestByPath(manifest).get("src/components/Hcard.astro")?.name).toBe("Business Card");
      expect(indexManifestByName(manifest).get("Business Card")?.path).toBe("src/components/Hcard.astro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws BlockManifestError with reason invalid-manifest on schema violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "anglesite-manifest-"));
    try {
      writeFileSync(join(dir, "blocks.manifest.json"), JSON.stringify({ schemaVersion: "wrong", modules: [] }));
      expect(() => loadBlockManifest(dir)).toThrow(BlockManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

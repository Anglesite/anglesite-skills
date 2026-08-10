import { z } from "zod";

export const propEditorKinds = ["text", "richtext", "image", "boolean", "number", "select", "color", "array"];

const blockManifestModuleSchema = z.object({
  path: z.string().describe("Project-relative component path, e.g. src/components/Hcard.astro"),
  export: z.string().describe("Default export name as imported, e.g. Hcard"),
  kind: z.enum(["astro", "custom-element"]).default("astro"),
  name: z.string().describe("Owner-facing block name shown in the Insert menu/palette"),
  description: z.string().default(""),
  icon: z.string().nullable().default(null),
  propEditors: z
    .array(
      z.object({
        prop: z.string(),
        editor: z.enum(propEditorKinds),
        options: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  slots: z.array(z.string()).default([]),
  placement: z.object({ allowedParents: z.array(z.string()).nullable().default(null) }).default({ allowedParents: null }),
});

export const blockManifestSchema = z.object({
  schemaVersion: z.literal("anglesite-block-manifest/1"),
  readme: z.string().optional(),
  modules: z.array(blockManifestModuleSchema),
});

// Builds the Open Agent Skills publish tree into a temp dir once per test file,
// so tests check what CI would publish to Anglesite/agent-skills without a
// committed copy in this repo.

import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";
import { buildAll } from "../../bin/build-agent-skills.ts";

export const ROOT = resolve(__dirname, "..", "..");

/** Build the full tree and return { outRoot, skillsOut, warnings }. */
export function buildPublishTree() {
  const outRoot = mkdtempSync(join(tmpdir(), "agent-skills-"));
  const { warnings } = buildAll({ root: ROOT, outRoot });
  afterAll(() => rmSync(outRoot, { recursive: true, force: true }));
  return { outRoot, skillsOut: join(outRoot, "skills"), warnings };
}

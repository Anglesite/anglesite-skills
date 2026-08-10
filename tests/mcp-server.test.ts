import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileVersion as fileVersionOf } from "../server/file-version.mjs";

const SERVER_PATH = resolve(__dirname, "..", "server", "index.mjs");

// ---------------------------------------------------------------------------
// Helpers — send JSON-RPC messages to the MCP server over stdio
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function startServer(projectRoot: string) {
  const proc = spawn("node", [SERVER_PATH], {
    env: { ...process.env, ANGLESITE_PROJECT_ROOT: projectRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return proc;
}

interface ProcessState {
  pending: Array<{
    resolve: (resp: JsonRpcResponse) => void;
    reject: (err: Error) => void;
  }>;
  buffer: string;
  stderr: string;
  exited: boolean;
}

/** Shared readline-style response queue per process. */
const responseQueues = new WeakMap<ReturnType<typeof spawn>, ProcessState>();

function getQueue(proc: ReturnType<typeof spawn>) {
  if (!responseQueues.has(proc)) {
    const state: ProcessState = {
      pending: [],
      buffer: "",
      stderr: "",
      exited: false,
    };
    responseQueues.set(proc, state);

    proc.stdout!.on("data", (chunk: Buffer) => {
      state.buffer += chunk.toString();
      const lines = state.buffer.split("\n");
      state.buffer = lines.pop()!; // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined && state.pending.length > 0) {
            state.pending.shift()!.resolve(parsed);
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      state.stderr += chunk.toString();
    });

    proc.on("exit", (code) => {
      state.exited = true;
      if (code !== 0 && state.pending.length > 0) {
        const err = new Error(
          `MCP server exited with code ${code}.\nstderr: ${state.stderr || "(empty)"}`,
        );
        for (const p of state.pending) {
          p.reject(err);
        }
        state.pending.length = 0;
      }
    });
  }
  return responseQueues.get(proc)!;
}

function sendNotification(
  proc: ReturnType<typeof spawn>,
  message: object,
): void {
  getQueue(proc); // ensure listener is attached
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

function sendMessage(
  proc: ReturnType<typeof spawn>,
  message: object,
): Promise<JsonRpcResponse> {
  const queue = getQueue(proc);
  return new Promise((resolve, reject) => {
    if (queue.exited) {
      reject(
        new Error(
          `MCP server already exited.\nstderr: ${queue.stderr || "(empty)"}`,
        ),
      );
      return;
    }
    queue.pending.push({ resolve, reject });
    proc.stdin!.write(JSON.stringify(message) + "\n");
  });
}

// ---------------------------------------------------------------------------
// MCP server integration tests
// ---------------------------------------------------------------------------

describe("MCP annotation server", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "anglesite-mcp-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("responds to initialize with server info and tool capabilities", async () => {
    const proc = startServer(tmpDir);
    try {
      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      expect(response.result).toBeDefined();
      const result = response.result as {
        serverInfo: { name: string };
        capabilities: { tools: object };
      };
      expect(result.serverInfo.name).toBe("anglesite");
      expect(result.capabilities.tools).toBeDefined();
    } finally {
      proc.kill();
    }
  });

  it("lists the annotation tools plus the apply_edit edit-pipeline tool", async () => {
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const result = response.result as { tools: { name: string }[] };
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "add_annotation",
        "apply_edit",
        "create_content",
        "create_page",
        "create_post",
        "get_component_model",
        "get_page_model",
        "list_annotations",
        "list_content",
        "resolve_annotation",
        "undo_edit",
      ]);
    } finally {
      proc.kill();
    }
  });

  it("add_annotation creates and returns an annotation", async () => {
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "add_annotation",
          arguments: {
            path: "/about",
            selector: "h1.hero",
            text: "Fix line-height",
          },
        },
      });
      const result = response.result as {
        content: { type: string; text: string }[];
      };
      expect(result.content).toHaveLength(1);
      const annotation = JSON.parse(result.content[0].text);
      expect(annotation.path).toBe("/about");
      expect(annotation.selector).toBe("h1.hero");
      expect(annotation.text).toBe("Fix line-height");
      expect(annotation.resolved).toBe(false);

      // Verify persisted to disk in versioned format
      const stored = JSON.parse(
        readFileSync(join(tmpDir, "annotations.json"), "utf-8"),
      );
      expect(stored.version).toBe(1);
      expect(stored.annotations).toHaveLength(1);
    } finally {
      proc.kill();
    }
  });

  it("list_annotations returns unresolved annotations", async () => {
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      // Add two annotations
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "add_annotation",
          arguments: { path: "/", selector: "h1", text: "Note 1" },
        },
      });
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "add_annotation",
          arguments: { path: "/about", selector: "h2", text: "Note 2" },
        },
      });

      // List all
      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_annotations", arguments: {} },
      });
      const result = response.result as {
        content: { type: string; text: string }[];
      };
      const annotations = JSON.parse(result.content[0].text);
      expect(annotations).toHaveLength(2);
    } finally {
      proc.kill();
    }
  });

  it("resolve_annotation marks annotation as resolved", async () => {
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      // Add annotation
      const addResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "add_annotation",
          arguments: { path: "/", selector: "h1", text: "Fix this" },
        },
      });
      const addResult = addResponse.result as {
        content: { text: string }[];
      };
      const { id } = JSON.parse(addResult.content[0].text);

      // Resolve it
      const resolveResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "resolve_annotation", arguments: { id } },
      });
      const resolveResult = resolveResponse.result as {
        content: { text: string }[];
      };
      const resolved = JSON.parse(resolveResult.content[0].text);
      expect(resolved.resolved).toBe(true);

      // Verify list excludes it
      const listResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_annotations", arguments: {} },
      });
      const listResult = listResponse.result as {
        content: { text: string }[];
      };
      const remaining = JSON.parse(listResult.content[0].text);
      expect(remaining).toHaveLength(0);
    } finally {
      proc.kill();
    }
  });

  it("list_content returns structured pages, posts, and images over stdio", async () => {
    mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "pages", "about.astro"),
      `<BaseLayout title="About" description="x" />`,
    );
    mkdirSync(join(tmpDir, "src", "content", "posts"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "content", "posts", "hello.md"),
      `---\ntitle: Hello\ndescription: d\npublishDate: 2026-06-01\ndraft: false\ntags: [intro]\n---\nBody`,
    );

    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_content", arguments: {} },
      });
      const result = response.result as { content: { text: string }[] };
      const listing = JSON.parse(result.content[0].text);
      expect(listing.pages).toEqual([
        expect.objectContaining({ route: "/about", filePath: "src/pages/about.astro", title: "About" }),
      ]);
      expect(listing.posts).toEqual([
        expect.objectContaining({ collection: "posts", slug: "hello", title: "Hello", draft: false, tags: ["intro"] }),
      ]);
      expect(listing.images).toEqual([]);
    } finally {
      proc.kill();
    }
  });

  it("create_page scaffolds a page and reports its route over stdio", async () => {
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_page", arguments: { name: "Contact Us" } },
      });
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const created = JSON.parse(result.content[0].text);
      expect(created.route).toBe("/contact-us");
      expect(created.filePath).toBe("src/pages/contact-us.astro");
      expect(readFileSync(join(tmpDir, created.filePath), "utf-8")).toContain('title="Contact Us"');
    } finally {
      proc.kill();
    }
  });

  it("apply_edit with op edit-style + dry_run returns edit-preview and leaves file unchanged", async () => {
    mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
    const filePath = join(tmpDir, "src", "pages", "about.astro");
    writeFileSync(filePath, '---\n---\n<h1 id="t">Welcome</h1>\n');
    const before = readFileSync(filePath);

    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "9",
            path: "/about/",
            selector: { tag: "h1", id: "t", classes: [], nthChild: 1, textContent: "Welcome" },
            op: "edit-style",
            value: { property: "color", value: "teal" },
            dry_run: true,
          },
        },
      });

      const result = response.result as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.type).toBe("anglesite:edit-preview");
      expect(body.after).toMatch(/color:\s*teal/);

      // File must be byte-identical — dry_run must not mutate disk
      expect(readFileSync(filePath)).toEqual(before);
    } finally {
      proc.kill();
    }
  });

  it("get_component_model returns a structured model over stdio", async () => {
    mkdirSync(join(tmpDir, "src", "components"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "components", "Card.astro"),
      `---\ninterface Props {\n  title: string;\n}\nconst { title } = Astro.props;\n---\n<article class="card"><h2>{title}</h2></article>\n<style>.card { padding: 1rem; }</style>\n`,
    );
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_component_model", arguments: { path: "src/components/Card.astro" } },
      });
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const model = JSON.parse(result.content[0].text);
      expect(model.path).toBe("src/components/Card.astro");
      expect(model.template.children[0].tag).toBe("article");
      expect(model.frontmatter.props[0].name).toBe("title");
      expect(model.styles[0].selector).toBe(".card");

      const failure = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_component_model", arguments: { path: "src/components/Nope.astro" } },
      });
      const failResult = failure.result as { content: { text: string }[]; isError?: boolean };
      expect(failResult.isError).toBe(true);
      expect(JSON.parse(failResult.content[0].text).reason).toBe("read-failed");
    } finally {
      proc.kill();
    }
  });

  it("get_page_model returns a block-annotated tree over stdio", async () => {
    mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
    mkdirSync(join(tmpDir, "src", "components"), { recursive: true });
    writeFileSync(
      join(tmpDir, "blocks.manifest.json"),
      JSON.stringify({
        schemaVersion: "anglesite-block-manifest/1",
        modules: [{ path: "src/components/Hcard.astro", export: "Hcard", name: "Business Card" }],
      }),
    );
    writeFileSync(join(tmpDir, "src", "components", "Hcard.astro"), `---\n---\n<div>card</div>\n`);
    writeFileSync(
      join(tmpDir, "src", "pages", "index.astro"),
      `---\nimport Hcard from "../components/Hcard.astro";\n---\n<Hcard />\n`,
    );
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_page_model", arguments: { path: "src/pages/index.astro" } },
      });
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBeFalsy();
      const model = JSON.parse(result.content[0].text);
      expect(model.tree.children[0].block.name).toBe("Business Card");
    } finally {
      proc.kill();
    }
  });

  it("apply_edit set-style-property round trip returns a piggybacked model", async () => {
    mkdirSync(join(tmpDir, "src", "components"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "components", "Card.astro"),
      `---\ninterface Props {\n  title: string;\n}\nconst { title } = Astro.props;\n---\n<article class="card"><h2>{title}</h2></article>\n<style>.card { padding: 1rem; }</style>\n`,
    );
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const modelResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_component_model", arguments: { path: "src/components/Card.astro" } },
      });
      const modelResult = modelResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(modelResult.isError).toBeFalsy();
      const model = JSON.parse(modelResult.content[0].text);
      const rule = model.styles[0];
      expect(rule.selector).toBe(".card");

      const editResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "rt-1",
            path: "src/components/Card.astro",
            op: "set-style-property",
            component: {
              path: "src/components/Card.astro",
              baseVersion: model.version,
              ruleSpan: rule.span,
              property: "color",
              value: "blue",
            },
          },
        },
      });
      const editResult = editResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(editResult.isError).toBeFalsy();
      const body = JSON.parse(editResult.content[0].text);
      expect(body.type).toBe("anglesite:edit-applied");
      expect(
        body.model.styles[0].declarations.some(
          (d: { property: string; value: string }) => d.property === "color" && d.value === "blue",
        ),
      ).toBe(true);

      // Confirm the write actually landed on disk, not just in the piggybacked model.
      const onDisk = readFileSync(join(tmpDir, "src", "components", "Card.astro"), "utf-8");
      expect(onDisk).toMatch(/color:\s*blue/);
    } finally {
      proc.kill();
    }
  });

  it("apply_edit insert-node round trip returns a piggybacked model", async () => {
    mkdirSync(join(tmpDir, "src", "components"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "components", "Card.astro"),
      `---\ninterface Props {\n  title: string;\n}\nconst { title } = Astro.props;\n---\n<article class="card"><h2>{title}</h2></article>\n<style>.card { padding: 1rem; }</style>\n`,
    );
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const modelResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_component_model", arguments: { path: "src/components/Card.astro" } },
      });
      const modelResult = modelResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(modelResult.isError).toBeFalsy();
      const model = JSON.parse(modelResult.content[0].text);

      const editResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "rt-2",
            path: "src/components/Card.astro",
            op: "insert-node",
            component: {
              path: "src/components/Card.astro",
              baseVersion: model.version,
              parentId: model.template.id,
              index: model.template.children.length,
              node: { kind: "element", tag: "footer" },
            },
          },
        },
      });
      const editResult = editResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(editResult.isError).toBeFalsy();
      const body = JSON.parse(editResult.content[0].text);
      expect(body.type).toBe("anglesite:edit-applied");
      expect(body.model.template.children.some((c: { tag?: string }) => c.tag === "footer")).toBe(true);
    } finally {
      proc.kill();
    }
  });

  it("editText replaces an element's inner content with re-serialized runs over stdio", async () => {
    mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
    const source = `---\n---\n<p id="t">Hello world</p>\n`;
    writeFileSync(join(tmpDir, "src", "pages", "index.astro"), source);
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const modelResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_page_model", arguments: { path: "src/pages/index.astro" } },
      });
      const modelResult = modelResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(modelResult.isError).toBeFalsy();
      const model = JSON.parse(modelResult.content[0].text);
      const p = model.tree.children.find((n: { tag?: string }) => n.tag === "p");

      const editResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "1",
            path: "src/pages/index.astro",
            op: "editText",
            component: {
              path: "src/pages/index.astro",
              baseVersion: model.version,
              textNodeId: p.id,
              runs: [{ text: "Bye", marks: ["strong"] }],
            },
          },
        },
      });
      const editResult = editResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(editResult.isError).toBeFalsy();
      const body = JSON.parse(editResult.content[0].text);
      expect(body.inverse.op).toBe("editText");
      const written = readFileSync(join(tmpDir, "src", "pages", "index.astro"), "utf-8");
      expect(written).toContain("<strong>Bye</strong>");
    } finally {
      proc.kill();
    }
  });

  it("setDesignToken patches global.css's :root and returns a stamped inverse over stdio", async () => {
    mkdirSync(join(tmpDir, "src", "styles"), { recursive: true });
    const css = `:root {\n  --color-primary: #2563eb;\n}\n`;
    writeFileSync(join(tmpDir, "src", "styles", "global.css"), css);
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const editResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "1",
            path: "src/styles/global.css",
            op: "setDesignToken",
            component: {
              path: "src/styles/global.css",
              baseVersion: fileVersionOf(css),
              token: "--color-primary",
              tokenValue: "#111111",
            },
          },
        },
      });
      const editResult = editResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(editResult.isError).toBeFalsy();
      const payload = JSON.parse(editResult.content[0].text);
      expect(payload.inverse.component.tokenValue).toBe("#2563eb");
      const written = readFileSync(join(tmpDir, "src", "styles", "global.css"), "utf-8");
      expect(written).toContain("--color-primary: #111111");
    } finally {
      proc.kill();
    }
  });

  // Final review — Important: the golden round-trip suite (tests/page-ops-roundtrip.test.ts)
  // calls resolvers directly and hand-rebuilds the inverse edit's baseVersion rather than
  // exercising the REAL apply_edit dispatcher-stamped `inverse` object end to end. This is the
  // one test that takes an edit-applied response's `inverse` VERBATIM — no rebuilding — and
  // sends it straight back through apply_edit as a real MCP tool call, proving the promise in
  // createEditAppliedContent's doc comment ("ready to send straight back through apply_edit
  // unmodified for undo") actually holds for insertBlock, the most structurally complex op.
  it("insertBlock's stamped inverse, sent back through apply_edit verbatim, restores the exact original bytes", async () => {
    mkdirSync(join(tmpDir, "src", "pages"), { recursive: true });
    const source = `---\n---\n<main><p id="keep">a</p></main>\n`;
    writeFileSync(join(tmpDir, "src", "pages", "index.astro"), source);
    const proc = startServer(tmpDir);
    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      sendNotification(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const modelResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_page_model", arguments: { path: "src/pages/index.astro" } },
      });
      const modelResult = modelResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(modelResult.isError).toBeFalsy();
      const model = JSON.parse(modelResult.content[0].text);
      const main = model.tree.children.find((n: { tag?: string }) => n.tag === "main");

      const insertResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "insert-1",
            path: "src/pages/index.astro",
            op: "insertBlock",
            component: {
              path: "src/pages/index.astro",
              baseVersion: model.version,
              parentId: main.id,
              index: 1,
              node: { kind: "element", tag: "footer" },
            },
          },
        },
      });
      const insertResult = insertResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(insertResult.isError).toBeFalsy();
      const insertBody = JSON.parse(insertResult.content[0].text);
      expect(insertBody.inverse.op).toBe("deleteBlock");
      const afterInsert = readFileSync(join(tmpDir, "src", "pages", "index.astro"), "utf-8");
      expect(afterInsert).toContain("<footer>");
      expect(afterInsert).not.toBe(source);

      // Send the dispatcher-stamped inverse straight back — VERBATIM, no rebuilding.
      const undoResponse = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "apply_edit",
          arguments: {
            id: "undo-1",
            path: "src/pages/index.astro",
            op: insertBody.inverse.op,
            component: insertBody.inverse.component,
          },
        },
      });
      const undoResult = undoResponse.result as { content: { text: string }[]; isError?: boolean };
      expect(undoResult.isError).toBeFalsy();
      const restored = readFileSync(join(tmpDir, "src", "pages", "index.astro"), "utf-8");
      expect(restored).toBe(source);
    } finally {
      proc.kill();
    }
  });
});

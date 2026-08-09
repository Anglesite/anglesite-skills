import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// v1 SDK client: the 2025-era Streamable HTTP dialect the shipped Anglesite-app
// still speaks. Kept as a devDependency for exactly this drain-window coverage.
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyHTTPTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// v2 SDK client: the MCP 2026-07-28 stateless protocol.
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHttpServer } from "../server/http-server.mjs";

/** Decode a Streamable HTTP response body: SSE frame(s) or a plain JSON object. */
async function decodeBody(res) {
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:"));
    return JSON.parse(data.map((l) => l.slice(5).trim()).join("\n"));
  }
  return JSON.parse(text);
}

describe("MCP Streamable HTTP transport", () => {
  let root;
  let handle;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-http-"));
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("serves a legacy (2025-era) v1 SDK client end to end", async () => {
    handle = await startHttpServer({ projectRoot: root, host: "127.0.0.1", port: 0 });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const client = new LegacyClient({ name: "test", version: "0.0.0" });
    await client.connect(new LegacyHTTPTransport(new URL(handle.url)));

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("list_annotations");
    expect(names).toContain("apply_edit");

    const res = await client.callTool({ name: "list_annotations", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual([]);

    await client.close();
  });

  it("serves the Anglesite-app's raw 2024-11-05 wire dialect statelessly", async () => {
    // Mirrors the app's `HTTPTransport`/`MCPClient` exactly: an `initialize`
    // handshake pinned to 2024-11-05, `notifications/initialized`, then plain
    // requests — every POST self-contained, no `Mcp-Session-Id` expected back.
    handle = await startHttpServer({ projectRoot: root, host: "127.0.0.1", port: 0 });

    const post = (body) =>
      fetch(handle.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "MCP-Protocol-Version": "2024-11-05",
        },
        body: JSON.stringify(body),
      });

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "anglesite-app", version: "0.0.0" },
      },
    });
    expect(init.status).toBe(200);
    // Stateless: the server must not mint a session.
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initBody = await decodeBody(init);
    expect(initBody.result.protocolVersion).toBe("2024-11-05");
    expect(initBody.result.serverInfo.name).toBe("anglesite");

    const inited = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(inited.status).toBe(202);

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    const listBody = await decodeBody(list);
    expect(listBody.result.tools.map((t) => t.name)).toContain("apply_edit");

    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_annotations", arguments: {} },
    });
    expect(call.status).toBe(200);
    const callBody = await decodeBody(call);
    expect(JSON.parse(callBody.result.content[0].text)).toEqual([]);
  });

  it("serves a modern (2026-07-28) stateless request with the _meta envelope", async () => {
    handle = await startHttpServer({ projectRoot: root, host: "127.0.0.1", port: 0 });

    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "list_annotations",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_annotations",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test-2026", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await decodeBody(res);
    expect(body.error).toBeUndefined();
    expect(body.result.resultType).toBe("complete");
    expect(JSON.parse(body.result.content[0].text)).toEqual([]);
  });

  it("serves a modern v2 SDK client end to end", async () => {
    handle = await startHttpServer({ projectRoot: root, host: "127.0.0.1", port: 0 });

    const client = new Client({ name: "test-v2", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_annotations");

    const res = await client.callTool({ name: "list_annotations", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual([]);

    await client.close();
  });
});

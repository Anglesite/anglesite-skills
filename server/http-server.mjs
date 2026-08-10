import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildServer } from "./index-tools.mjs";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Start the Anglesite MCP server over Streamable HTTP on a single `/mcp` endpoint.
 *
 * Stateless (MCP 2026-07-28): every request is self-contained, so no session is
 * minted and no `Mcp-Session-Id` handling exists. `createMcpHandler` serves the
 * 2026-07-28 protocol and, via its built-in `legacy: 'stateless'` fallback,
 * still answers 2025-era Streamable HTTP traffic — including the
 * `initialize`/`notifications/initialized` handshake older clients (the
 * Anglesite-app's current `MCPClient`) send — per-request from the same
 * `buildServer` factory, so the two protocol eras can never drift apart.
 *
 * Returns `{ url, close }` where `url` is the full endpoint (`http://host:port/mcp`).
 */
export async function startHttpServer({ projectRoot, host = "127.0.0.1", port = 4399 }) {
  const handler = createMcpHandler(() => buildServer(projectRoot), {
    onerror: (err) => console.error("[anglesite] MCP handler error:", err),
  });
  const nodeHandler = toNodeHandler(handler);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/mcp") { res.writeHead(404).end(); return; }
      await nodeHandler(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
    }
  });

  await new Promise((resolve) => httpServer.listen(port, host, resolve));
  const actualPort = httpServer.address().port;
  const endpoint = `http://${host}:${actualPort}/mcp`;
  console.log(`Anglesite MCP listening on ${endpoint}`);

  return {
    url: endpoint,
    close: async () => {
      await handler.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

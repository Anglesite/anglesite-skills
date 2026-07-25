---
name: serena
description: Set up Serena for semantic, symbol-level code navigation when working on the Anglesite plugin itself — indexing the project and starting its MCP server via uvx. Use when tracing cross-skill references or finding symbol usages across the skills tree.
---

# Serena (optional, plugin development)

[Serena](https://github.com/oraios/serena) provides semantic, symbol-level code navigation via language servers. It's useful when working on the plugin itself (tracing cross-skill references, finding symbol usages across the skills tree). Not required — all standard tools work without it.

**Setup:**

```sh
# Index the project (one-time)
uvx -p 3.13 --from git+https://github.com/oraios/serena serena project index

# Start the MCP server
uvx -p 3.13 --from git+https://github.com/oraios/serena serena start-mcp-server --project .
```

Config lives in `.serena/project.yml`. Requires Python 3.13 and [uv](https://docs.astral.sh/uv/).

# MCP Integration

Wavelet includes a Model Context Protocol (MCP) server that lets AI agents interact with your views and streams directly. No HTTP request construction needed - the agent gets typed tools with descriptions.

## Setup

Add Wavelet to your MCP configuration:

### Claude Code / Claude Desktop

Add to your MCP settings:

```json
{
  "mcpServers": {
    "wavelet": {
      "command": "npx",
      "args": ["@risingwave/wavelet-mcp"],
      "env": {
        "WAVELET_DATABASE_URL": "postgres://root@localhost:4566/dev"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "wavelet": {
      "command": "npx",
      "args": ["@risingwave/wavelet-mcp"],
      "env": {
        "WAVELET_DATABASE_URL": "postgres://root@localhost:4566/dev"
      }
    }
  }
}
```

## Available tools

### `list_views`

Lists all materialized views with their column schemas.

```
Agent: "What views are available in Wavelet?"
Tool call: list_views
Result: { "leaderboard": { "columns": [{ "name": "player_id", "type": "varchar" }, ...] } }
```

### `query_view`

Queries a view with optional filters. Data is always fresh - views are incrementally maintained.

```
Agent: "Show me the top players"
Tool call: query_view { view: "leaderboard", limit: 10 }
Result: { "view": "leaderboard", "rows": [...], "count": 10 }
```

With filter:

```
Agent: "What's tenant t1's usage?"
Tool call: query_view { view: "tenant_usage", filter: { "tenant_id": "t1" } }
```

### `list_streams`

Lists event streams and their column schemas.

### `emit_event`

Writes a single event to a stream.

```
Agent: "Log this LLM call"
Tool call: emit_event { stream: "llm_events", data: { "tenant_id": "t1", "model": "gpt-4o", "tokens": 500, "cost_usd": 0.005 } }
```

### `emit_batch`

Writes multiple events in one call.

### `run_sql`

Executes a read-only SQL query for ad-hoc analysis. Only SELECT statements are allowed.

## Use cases

### AI agent state monitoring

An AI agent can query its own usage in real-time:

```
Agent: "Am I close to the token budget?"
Tool call: query_view { view: "tenant_usage", filter: { "tenant_id": "my-agent" } }
Result: { "rows": [{ "total_tokens": 45000, "total_cost": 0.45 }] }
Agent: "I've used 45K tokens ($0.45). Switching to a lighter model to stay under budget."
```

### Reactive agent behavior

An agent can monitor a view and change behavior based on computed state - without re-querying the database on every step.

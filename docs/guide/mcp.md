# MCP Integration

Wavelet includes a Model Context Protocol (MCP) server that lets AI agents interact with your queries and events directly. No HTTP request construction needed - the agent gets typed tools with descriptions.

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

### `list_queries`

Lists all queries (materialized views) with their column schemas.

```
Agent: "What queries are available in Wavelet?"
Tool call: list_queries
Result: { "leaderboard": { "columns": [{ "name": "player_id", "type": "varchar" }, ...] } }
```

### `query`

Queries a materialized view with optional filters. Data is always fresh - queries are incrementally maintained.

```
Agent: "Show me the top players"
Tool call: query { query: "leaderboard", limit: 10 }
Result: { "query": "leaderboard", "rows": [...], "count": 10 }
```

With filter:

```
Agent: "What's tenant t1's usage?"
Tool call: query { query: "tenant_usage", filter: { "tenant_id": "t1" } }
```

### `list_events`

Lists event tables and their column schemas.

### `emit_event`

Writes a single event.

```
Agent: "Log this LLM call"
Tool call: emit_event { event: "llm_events", data: { "tenant_id": "t1", "model": "gpt-4o", "tokens": 500, "cost_usd": 0.005 } }
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
Tool call: query { query: "tenant_usage", filter: { "tenant_id": "my-agent" } }
Result: { "rows": [{ "total_tokens": 45000, "total_cost": 0.45 }] }
Agent: "I've used 45K tokens ($0.45). Switching to a lighter model to stay under budget."
```

### Reactive agent behavior

An agent can monitor a query and change behavior based on computed state - without re-querying the database on every step.

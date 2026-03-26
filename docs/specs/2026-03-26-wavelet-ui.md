# Wavelet UI — Real-time React Components

**Date**: 2026-03-26
**Package**: `@risingwave/wavelet-ui`
**Status**: Draft

## Motivation

Wavelet's SDK gives developers `useWavelet()` — a hook that returns `{ data, isLoading, error }`. This is great for full control, but every developer ends up reimplementing the same patterns:

1. Highlight rows that just changed
2. Animate counters ticking up/down
3. Show a live feed of recent events
4. Display connection status

These patterns are **unique to real-time diff-based data** — Metabase and Grafana can't do them because they poll. Wavelet can, because it streams row-level diffs (insert/update/delete).

`@risingwave/wavelet-ui` provides a small set of React components that are **diff-aware by default**: they know which rows were just inserted, updated, or deleted, and animate accordingly.

## Non-goals

- **Not a charting library.** No line charts, bar charts, pie charts. Use Recharts/D3/whatever for that.
- **Not a dashboard builder.** No drag-and-drop, no layout engine.
- **Not a design system.** Components ship with minimal default styles. Users override with CSS or className.

## Design Overview

### Layer 1: `useWaveletDiff` hook

A new hook that wraps `useWavelet` but tracks **which rows changed and how** in the last diff cycle:

```tsx
const { data, changes, isLoading, error } = useWaveletDiff<Row>('leaderboard', {
  keyBy: 'player_id',
})

// changes is a Map<string, 'inserted' | 'updated' | 'deleted'>
// keyed by the keyBy field value
// automatically clears after `changeRetention` ms (default 500ms)
```

This is the foundation all components build on. Users who want custom UI but still want diff tracking can use this hook directly.

### Layer 2: Components

#### `<WaveletTable>`

Renders a data table with row-level change animations.

```tsx
<WaveletTable
  view="leaderboard"
  keyBy="player_id"
  columns={[
    { key: 'player_id', header: 'Player' },
    { key: 'total_score', header: 'Score', align: 'right' },
    { key: 'games_played', header: 'Games', align: 'right' },
  ]}
  sortBy="total_score"
  sortDirection="desc"
  limit={20}
  params={{ team: 'blue' }}
/>
```

- Inserted rows flash green
- Updated rows flash yellow
- Deleted rows fade out then remove
- Animation duration configurable via `changeDuration` prop (default 500ms)
- Accepts `className`, `rowClassName`, `cellClassName` for styling
- `onRowClick` callback

#### `<WaveletCounter>`

Single-value display with animated number transitions.

```tsx
<WaveletCounter
  view="active_users"
  field="count"
  keyBy="id"
  label="Active Users"
  format={(n) => n.toLocaleString()}
/>
```

- Animates between old and new values (count up/down)
- Optional `trend` indicator (arrow up/down based on direction of change)
- Accepts `className` for styling

#### `<WaveletFeed>`

Append-only list showing recent inserts.

```tsx
<WaveletFeed
  view="activity_log"
  keyBy="event_id"
  maxItems={50}
  renderItem={(item) => (
    <span>{item.user} did {item.action}</span>
  )}
/>
```

- New items slide in from top with animation
- Auto-trims to `maxItems`
- Optional `emptyState` prop

#### `<WaveletStatus>`

Connection status indicator.

```tsx
<WaveletStatus />
// or
<WaveletStatus labels={{ connected: 'Live', connecting: 'Connecting...', error: 'Offline' }} />
```

- Shows current WebSocket connection state
- Green dot = connected, yellow = connecting, red = error
- Minimal default styling, fully overridable

### Styling Strategy

- **No CSS-in-JS runtime.** Components use plain CSS classes.
- Ship a small CSS file (`@risingwave/wavelet-ui/styles.css`) with default animations and minimal layout.
- All class names prefixed with `wv-` to avoid collisions.
- Users can import the CSS or write their own — components work either way via `className` overrides.
- CSS animations use `@keyframes` for insert/update/delete highlights.

## Package Structure

```
packages/ui/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # re-exports everything
│   ├── useWaveletDiff.ts     # diff-tracking hook
│   ├── WaveletTable.tsx
│   ├── WaveletCounter.tsx
│   ├── WaveletFeed.tsx
│   ├── WaveletStatus.tsx
│   └── styles.css            # default animations
```

## Dependencies

- **Peer**: `react >=18`, `@risingwave/wavelet-sdk`
- **No other deps.** Zero runtime dependencies beyond React and the SDK.

## Key Decisions

1. **Build on `useWavelet`, not raw WebSocket.** The SDK already handles reconnection, auth, and merging. UI components are a thin layer on top.
2. **`keyBy` is required for all components.** Without a stable key, diff tracking is meaningless. This is an intentional constraint.
3. **CSS file is opt-in.** Components render correct HTML structure with data attributes (`data-wv-change="inserted"`) regardless. The CSS file provides default animations but isn't required.
4. **No headless mode needed.** `useWaveletDiff` IS the headless mode. Components are the styled mode. Two layers, clean separation.

## Trade-offs

- **Limited component set.** Intentionally small — 4 components + 1 hook. We can add more later based on user demand. Starting small avoids maintenance burden.
- **No SSR support initially.** Real-time components are inherently client-side. SSR can show loading state; hydration picks up the subscription.
- **Requires `keyBy`.** Some views may not have a natural primary key. Users need to add one or use `useWavelet` directly.

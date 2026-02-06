# Aizu TypeScript SDK

TypeScript SDK and CLI for [Aizu](https://aizu.sh) — build reactive backends with WebAssembly.

## What's in this package

This package serves two purposes:

- **CLI** (`npx aizu`) — deploy pipeline: schema codegen, WASM build, upload
- **Client SDK** (`import from "aizu"`) — React hooks for real-time queries, mutations, and auth

## CLI

### Initialize a project

```bash
npx aizu init
```

Creates an `aizu.toml` config and a starter Rust crate with schema definitions.

### Deploy

```bash
AIZU_DEPLOY_KEY=<key> npx aizu deploy
```

Runs the full pipeline:
1. Generate Rust + TypeScript types from `schemas/*.toml`
2. Build the WASM module (`cargo build --target wasm32-wasip1`)
3. Upload to your Aizu deployment
4. Wait for the module to be ready

## Client SDK

### Setup

```tsx
import { AizuProvider } from "aizu/react";

function App() {
  return (
    <AizuProvider url="https://myproject.aizu.sh">
      <MyApp />
    </AizuProvider>
  );
}
```

### Queries (real-time)

```tsx
import { useQuery } from "aizu/react";

function TodoList() {
  const todos = useQuery("list_todos", { user_id: "123" });

  if (todos === undefined) return <div>Loading...</div>;

  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}
```

Queries automatically update when server data changes via WebSocket subscriptions.

### Mutations

```tsx
import { useMutation } from "aizu/react";

function CreateTodo() {
  const { mutate: createTodo, isPending } = useMutation("create_todo");

  return (
    <button
      onClick={() => createTodo({ title: "New todo" })}
      disabled={isPending}
    >
      {isPending ? "Creating..." : "Create"}
    </button>
  );
}
```

### Authentication

```tsx
import { useCurrentUser, useAizuAuth } from "aizu/react";

function Profile() {
  const user = useCurrentUser();
  const auth = useAizuAuth();

  if (!user) return <button onClick={() => auth.login(...)}>Sign in</button>;

  return <div>Hello, {user.name}</div>;
}
```

## Configuration

### `aizu.toml`

```toml
[project]
name = "my-project"
url = "http://localhost:4000"

[functions]
path = "./aizu"

[schemas]
path = "schemas/"
output = "src/generated/"
ts_output = "src/generated/"
```

## Requirements

- Node.js >= 18
- React >= 18 (for the SDK hooks)
- Rust with `wasm32-wasip1` target (for building functions)

## Contributing

We are not currently accepting external contributions. Feel free to open issues for bugs or feature requests.

## License

MIT

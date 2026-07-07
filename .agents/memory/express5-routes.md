---
name: Express 5 route return pattern
description: How to handle early returns in Express 5 route handlers without TS7030 errors
---

In Express 5 with TypeScript strict mode, route handlers must not use `return res.status(...)` because TypeScript reports TS7030 ("not all code paths return a value") when the return type of `res.json()` / `res.status()` doesn't match `void`.

**Rule:** Use the two-statement pattern instead of a one-liner return.

**How to apply:** Any time a route handler has an early exit (validation, not-found guard, etc.):

```ts
// WRONG — causes TS7030
if (!status) return res.status(400).json({ error: "status required" });

// CORRECT — no TS errors
if (!status) { res.status(400).json({ error: "status required" }); return; }
```

**Why:** Express 5 route handler signatures are typed as `RequestHandler` which returns `void | Promise<void>`. `res.json()` returns `Response` not `void`, so TypeScript sees a branch that returns a non-void value and raises TS7030.

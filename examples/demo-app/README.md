# Demo app

A tiny password-reset app used to test Exhibit end to end (`examples/PROJ-123.md` is its ticket).

| Path | What it does |
|---|---|
| `/login` | Sign-in form with a "Forgot password?" link |
| `/forgot` | Reset form; `?email=` shows the result |

Known accounts: `ana@example.com`.

**Deliberate bug:** an unknown email shows "No account found for this email" instead of the
same "Check your inbox" message — this violates AC3 (no account enumeration), and Exhibit
should report it.

```bash
node examples/demo-app/server.mjs   # http://localhost:4173
```

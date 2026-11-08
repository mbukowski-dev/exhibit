// Tiny demo app for Exhibit: password reset with a deliberate bug (AC3).
// Run: node examples/demo-app/server.mjs  → http://localhost:4173
import { createServer } from "node:http";

const USERS = new Set(["ana@example.com"]);
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;max-width:420px;margin:60px auto}label,input,button{display:block;margin:8px 0}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (html, status = 200) => { res.writeHead(status, { "content-type": "text/html" }); res.end(html); };

    if (url.pathname === "/" || url.pathname === "/login") {
      return send(page("Sign in", `<form><label>Email <input name="email" type="email"></label>
        <label>Password <input name="password" type="password"></label><button>Sign in</button></form>
        <a href="/forgot">Forgot password?</a>`));
    }
    if (url.pathname === "/forgot" && req.method === "GET") {
      const email = url.searchParams.get("email");
      if (email === null) {
        return send(page("Reset password", `<form method="get" action="/forgot">
          <label>Email <input name="email" type="email"></label><button>Send reset link</button></form>`));
      }
      // BUG (violates AC3): reveals whether an account exists.
      return USERS.has(email)
        ? send(page("Reset password", `<p role="status">Check your inbox</p>`))
        : send(page("Reset password", `<p role="alert">No account found for this email</p>`));
    }
    send(page("Not found", "<p>404</p>"), 404);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4173);
  createApp().listen(port, () => console.log(`demo app on http://localhost:${port}`));
}

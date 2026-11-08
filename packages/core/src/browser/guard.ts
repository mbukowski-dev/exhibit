import type { BrowserContext, Request } from "playwright";

/**
 * Keeps the agent inside the app under test. Blocks every top-level
 * navigation to another origin — whether from a "goto", a clicked link, a
 * form submit or a script redirect — so a hostile page cannot lure the agent
 * (and the credentials it types) elsewhere. Sub-resources (CDNs, APIs, fonts)
 * are not affected. Extra origins (e.g. an SSO login page) can be allowed in
 * .exhibit.yml (`allowed_origins`).
 */
export class NavigationGuard {
  private readonly allowed: Set<string>;
  private readonly blocked: string[] = [];
  private active = false;

  constructor(baseUrl: string, extraOrigins: string[] = []) {
    this.allowed = new Set([new URL(baseUrl).origin, ...extraOrigins.map((o) => new URL(o).origin)]);
  }

  isAllowed(url: string): boolean {
    if (url === "about:blank") return true;
    try {
      return this.allowed.has(new URL(url).origin);
    } catch {
      return false;
    }
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route("**/*", (route) => {
      const req = route.request();
      if (this.active && isTopLevelNavigation(req) && !this.isAllowed(req.url())) {
        this.blocked.push(req.url());
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
  }

  /** Start enforcing — call after the project's own login flow (which may use SSO). */
  activate(): void {
    this.active = true;
  }

  /** Navigations blocked since the last call. */
  takeBlocked(): string[] {
    return this.blocked.splice(0);
  }
}

function isTopLevelNavigation(req: Request): boolean {
  try {
    return req.isNavigationRequest() && req.frame().parentFrame() === null;
  } catch {
    return false; // e.g. service-worker requests have no frame
  }
}

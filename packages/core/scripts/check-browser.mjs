// Starts the browser Exhibit uses and closes it again. Exit code 0 means it can run on this machine.
// Used by scripts/install-browser.sh to decide whether system packages are needed at all.
import { chromium } from "playwright";

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<p>ok</p>");
  await browser.close();
} catch (e) {
  console.error(`Chromium could not start: ${String(e?.message ?? e).split("\n")[0]}`);
  process.exit(1);
}

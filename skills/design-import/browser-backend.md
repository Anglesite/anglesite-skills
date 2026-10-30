# Step 1 — Choose a browser backend

Skip this step if SOURCE is `freedesignmd` — freedesignmd files are markdown, no browser needed.

Resolve which backend renders the Canva site for extraction, preferring Safari
on macOS (no install, real-browser fingerprint) with Playwright as the
cross-platform fallback. Run:

```sh
node ${CLAUDE_PLUGIN_ROOT}/scripts/design-import/canva-safari.mjs --check
```

Branch on the exit code:

- **0** — set RENDER_BACKEND=safari. Tell the owner:
  > "I can use Safari on your Mac to read your Canva site exactly the way
  > visitors see it. A Safari window will open and browse your pages by
  > itself — you don't need to do anything, just don't click inside that
  > window."
- **3** (Safari present, automation not enabled) — show this once:
  > "Your Mac's Safari can help me import your design without installing
  > anything, but it needs one-time permission. In Safari Technology Preview,
  > open Settings → Advanced and turn on 'Show features for web developers',
  > then Settings → Developer and turn on 'Allow remote automation'.
  > Say 'ready' when done, or 'skip' to continue without it."
  If the owner enables it, re-run the check. If they skip, fall through to
  the Playwright branch below.
- **2 or 4** — fall through to Playwright silently (Safari unavailable is
  the normal case on Linux/Windows).

**Playwright branch:**

Tell the owner:
> "I need to check if a browser tool is available — it's how I read your Canva
> site's design."

```sh
npm ls playwright
```

If Playwright is installed, set RENDER_BACKEND=playwright. If not, tell the owner:

> "To read your Canva site's design, I need to install a browser tool called
> Playwright. It's about 150 MB. Want me to go ahead and install it?"

If they agree:

```sh
npm install playwright
npx playwright install chromium
```

Set RENDER_BACKEND=playwright.

If they decline, tell the owner:

> "No problem! We have two other options:
> 1. Export your Canva design as a PDF and I can extract the colors and fonts from that
> 2. We can build the design together from scratch — just say `/anglesite:design-interview`"

Stop and wait.

# Step 1 — Detect platform and discover content

Tell the owner:
> "I'm going to look at your existing website to see what content is there and
> figure out the best way to import it. This takes about a minute."

### 1a — Detect the platform

**WordPress** — check for the REST API:

```sh
curl -s -o /dev/null -w "%{http_code}" SITE_URL/wp-json/
```

If the response is `200`, this is a WordPress site. Tell the owner:
> "Your site is built on WordPress. That makes importing easier — WordPress has
> a built-in API I can read directly."

**Ghost** — check for the Ghost Content API:

```sh
curl -s -o /dev/null -w "%{http_code}" SITE_URL/ghost/api/
```

Also check for `<meta name="generator" content="Ghost">` via WebFetch. If Ghost
is detected, tell the owner:
> "Your site is built on Ghost. If you can give me a Content API key from
> your Ghost admin panel (Integrations → Custom Integration), I can pull
> everything directly. Otherwise I can use the RSS feed."

Read `references/docs/import/ghost.md` for platform-specific extraction details.

**Blogger** — check for the Atom feed:

```sh
curl -s -o /dev/null -w "%{http_code}" SITE_URL/feeds/posts/default
```

Also check for `.blogspot.com` in the URL or `<meta name="generator" content="Blogger"/>`.
If detected, tell the owner:
> "Your site is on Blogger. Blogger has great export options — I can read
> everything directly from its feed."

Read `references/docs/import/blogger.md` for platform-specific extraction details.

**Other hosted platforms** — if none of the above matched, use WebFetch on the homepage:

Use WebFetch on SITE_URL with this prompt:
> "Look at the page source. Identify which platform this site is built on.
> Check for: 'squarespace' in script URLs or meta tags, 'wix' or 'Thunderbolt'
> in the source, 'cdn.shopify.com' or '/collections/' paths, 'media.tumblr.com'
> or tumblr theme files, 'miro.medium.com' or Medium-specific markup,
> 'substackcdn.com' or substack paths, 'cdnjs.weebly.com' or 'Powered by
> Weebly', 'data-wf-site' or 'assets.website-files.com' for Webflow,
> 'img1.wsimg.com' or 'secureservercdn.net' for GoDaddy Website Builder,
> 'static.carrd.co' or Carrd HTML structure for Carrd,
> 'micro.blog' or micropub links for Micro.blog,
> 'writefreely' or 'write.as' for WriteFreely.
> Report which platform you detect, or 'unknown' if you can't tell."

For each detected platform, read the corresponding doc from `references/docs/import/`:

| Platform | Detection signals | Doc reference |
| --- | --- | --- |
| Squarespace | `squarespace` in scripts/meta, `squarespace-cdn.com` | `references/docs/import/squarespace.md` |
| Wix | `wix` or `Thunderbolt` in source, `wixstatic.com` | `references/docs/import/wix.md` (also see Wix MCP path in Step 1a.1) |
| Shopify | `cdn.shopify.com`, `/collections/`, `/products/` | `references/docs/import/shopify.md` |
| Medium | `miro.medium.com`, `.medium.com` domain | `references/docs/import/medium.md` |
| Substack | `substackcdn.com`, `.substack.com` domain | `references/docs/import/substack.md` |
| Weebly | `cdnjs.weebly.com`, "Powered by Weebly" | `references/docs/import/weebly.md` |
| Tumblr | `media.tumblr.com`, `.tumblr.com` domain | `references/docs/import/tumblr.md` |
| Webflow | `data-wf-site`, `assets.website-files.com` | `references/docs/import/webflow.md` |
| GoDaddy | `img1.wsimg.com`, `secureservercdn.net` | `references/docs/import/godaddy.md` |
| Carrd | `static.carrd.co`, `.carrd.co` domain | `references/docs/import/carrd.md` |
| Micro.blog | `micro.blog`, micropub endpoint | `references/docs/import/microblog.md` |
| WriteFreely | `writefreely` generator, `.write.as` domain | `references/docs/import/writefreely.md` |

Tell the owner what platform was detected and read the platform doc for
extraction instructions. For unknown platforms, tell the owner:
> "I'm not sure what platform your site uses, but I can still import the content
> by reading each page. It just takes a bit longer."

Store the detected platform as PLATFORM.

### 1a.1 — Wix MCP server detection (Wix only)

If PLATFORM is `wix`, check whether the [Wix MCP server](https://dev.wix.com/docs/wix-cli/mcp)
is installed by looking for tools whose names end in `__ListWixSites` and
`__ExecuteWixAPI` (the prefix is the MCP server's namespaced ID, which varies
per install). If both are available, set USE_WIX_MCP=true.

If the tools are not available, surface a one-line install hint:

> "Your Wix site has a much cleaner import path if you enable the Wix MCP
> server — it gives me direct access to your blog posts and metadata via
> Wix's API instead of scraping rendered pages. It only works if you're
> signed in to the Wix account that owns this site. Want to install it
> before we continue? Otherwise I'll fall through to the slower extraction
> method."

If the owner installs it, ask them to restart the session so the new tools
load, then re-run `/anglesite:import`. If they decline (or aren't the site
owner — the MCP only works for the authenticated Wix account), set
USE_WIX_MCP=false and continue with Playwright + curl extraction.

When USE_WIX_MCP=true:

1. Call `ListWixSites` to enumerate the owner's Wix sites. If more than one
   matches (e.g., active site plus an archived copy), present the list and
   ask which one to import from. Store the chosen site ID as WIX_SITE_ID.
2. The Wix MCP path covers blog posts and their metadata. **Static pages and
   design tokens are not exposed via the API** — Playwright (Step 2a / 3b)
   is still required for those, so don't skip the Playwright install prompt.

Read `references/docs/import/wix.md` ("Wix MCP server" section)
for the full extraction workflow and operational notes.

### 1a.2 — Rendered-page backend detection (Wix and Squarespace)

If PLATFORM is `wix` or `squarespace`, resolve which backend renders pages
for extraction. Run:

```sh
node references/scripts/import/browser/safari-driver.mjs --check
```

Branch on the exit code:

- **0** — set RENDER_BACKEND=safari. Tell the owner:
  > "I can use Safari on your Mac to read your site exactly the way visitors
  > see it. A Safari window will open and browse your pages by itself —
  > you don't need to do anything, just don't click inside that window."
- **3** (Safari present, automation not enabled) — show this once:
  > "Your Mac's Safari can help me import your site more accurately, but it
  > needs one-time permission. In Safari Technology Preview, open
  > Settings → Advanced and turn on 'Show features for web developers',
  > then Settings → Developer and turn on 'Allow remote automation'.
  > Say 'ready' when done, or 'skip' to continue without it."
  If the owner enables it, re-run the check. If they skip, fall through to
  the Playwright branch below.
- **2 or 4** — fall through to Playwright silently (Safari unavailable is
  the normal case on Linux/Windows).

**Playwright branch:** follow the existing Playwright install check (Step 2a);
if installed or the owner accepts the install, set RENDER_BACKEND=playwright.
Otherwise set RENDER_BACKEND=none (content still imports via curl/regex,
JSON endpoints, and WebFetch; design tokens are skipped).

Both backends share one invocation contract — the same flags and the same
`tokens`/`content` JSON. Substitute the driver path for the resolved backend:

- safari: `node references/scripts/import/browser/safari-driver.mjs "URL…" [flags]` (batch all URLs in ONE invocation; NDJSON out, one line per URL; a line with `"error"` falls back per-page like a Playwright timeout)
- playwright: `node references/scripts/import/wix/wix-playwright.mjs "URL" [flags]` (one URL per invocation)

Both drivers also accept `--fullPage`, reserved for a future full-page
(header + footer image) extraction pass — no step in this skill passes it
today, so its absence from the invocations below is intentional, not an
oversight.

### 1b — Platform-specific content discovery

Read `references/skills/import/content-discovery.md` and follow the
instructions for the detected PLATFORM. Build BLOG_POSTS and STATIC_PAGES from
the results.

### 1c — Check for existing content

```sh
find src/content/posts -name "*.mdoc" -type f
```

If `.mdoc` files exist, note their slugs and tell the owner:
> "I found [N] existing posts. If any imported posts have the same slug, I'll
> skip them rather than overwrite."

Build a SKIPPED_SLUGS set from existing filenames.

### 1c.2 — Check for existing pages

```sh
find src/pages -name "*.astro" -type f
```

Build a PROTECTED_PAGES set from all existing page paths (relative to
`src/pages/`, without the `.astro` extension). For example,
`src/pages/contact.astro` becomes `contact` and
`src/pages/contact/thanks.astro` becomes `contact/thanks`.

These pages will not be overwritten during import. Initialise an empty
SKIPPED_PAGES list — pages skipped due to protection will be added here
for reporting in Step 7.

### 1d — Present the inventory

Tell the owner what was found. Example:

> "Here's what I found on your website:
>
> **Blog posts:** 23 posts (July 2024 – February 2026)
> **Pages:** 6 pages (About, FAQ, Services, Contact, Gallery, Get Involved)
>
> I'll import all the blog posts, extract the content from each page, and
> set up redirects so your search rankings carry over. The import will take
> about 5–10 minutes for a blog this size."

If BLOG_POSTS is empty, tell the owner — skip to Step 3 for pages only, or
Step 4 if image galleries were detected.

Import everything by default — posts, pages, images, and redirects. Do not
prompt the owner to choose a scope. The whole point of `/anglesite:import` is
to import the entire website. If the owner wants to remove something afterward,
they can delete it.

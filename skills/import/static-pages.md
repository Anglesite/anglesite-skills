# Step 3 — Handle static pages

Process STATIC_PAGES.

### 3a — Extract homepage branding

Before processing individual pages, extract site-wide branding from the homepage.
Use WebFetch on SITE_URL with this prompt:

> "Look at this website's homepage and extract:
> 1. The site name or business name (from the logo, header, or `<title>` tag)
> 2. The tagline or slogan (if visible)
> 3. A description of the logo (if there's an image logo, describe it and provide its URL)
> 4. The primary brand colors used (header background, accent buttons, link colors — give hex codes if possible)
> 5. The main navigation links: for each link, give the visible text and the URL it points to
> 6. The full text content of the homepage converted to clean Markdown"

Store the navigation links as NAV_LINKS. Update `.site-config` with the
site name if it differs from the scaffolded default. Note the brand colors for
later use in theming.

### 3b — Extract content from every page

**Every page in STATIC_PAGES must have its content extracted.** Do not create
empty stubs or placeholder pages. Use the best available source:

**WordPress:** Page content is already available from the REST API (`content.rendered`).
Convert HTML to Markdown as in Step 2b.

**Squarespace (WXR):** Page content is in the XML export (`<content:encoded>`).
Note that Squarespace only exports text blocks — complex layouts (galleries,
forms, product grids) are not included in the export.

**Wix:** Use the RENDER_BACKEND driver (Step 1a.2). Styles were already
extracted from the homepage in Step 2a, so skip redundant style extraction:

- **safari** — batch every static page URL in one invocation with
  `--content-only`:

  ```sh
  node ${CLAUDE_PLUGIN_ROOT}/scripts/import/browser/safari-driver.mjs "PAGE_URL_1" "PAGE_URL_2" … --content-only
  ```

  Read back the NDJSON lines, one per page.

- **playwright** — one invocation per page:

  ```sh
  node ${CLAUDE_PLUGIN_ROOT}/scripts/import/wix/wix-playwright.mjs "PAGE_URL" --content-only
  ```

If the rendered backend fails on a specific page (Playwright timeout/crash, or
a Safari NDJSON line with `"error"`), fall back to curl + regex for that page:

```sh
curl -sL "PAGE_URL" > /tmp/wix-page.html
node ${CLAUDE_PLUGIN_ROOT}/scripts/import/wix/wix-extract.mjs page /tmp/wix-page.html
```

Both methods strip navigation and footer boilerplate automatically.

**All other platforms and any page without pre-fetched content:** WebFetch is
mandatory. This includes Weebly, GoDaddy, Carrd, Webflow without API,
Squarespace without export, and any platform where RSS was the primary blog
extraction source (RSS never contains static pages).

Use WebFetch on each page URL with this prompt:
> "Look at this page and tell me:
> 1. The page title
> 2. Whether the page uses a platform feature that can't be statically exported
>    (booking/scheduling, e-commerce/store, event calendar, forum, member area,
>    contact form, image gallery with 10+ images). If so, name the feature.
> 3. A 1–3 sentence summary of the page's purpose and content
> 4. The full text content converted to clean Markdown (if it's a content page).
>    Include all headings, paragraphs, lists, images (with src URLs), and links.
>    Remove navigation, headers, footers, sidebars, and platform chrome."

### 3c — Categorize and create pages

Categorize each page:
- **App-powered**: uses booking, store, events, forum, members, or similar
  platform features that require runtime infrastructure
- **Gallery**: primarily an image gallery or portfolio (10+ images)
- **Content page**: regular text/image content

**Wix slug renaming:** Before creating the file, check whether the Wix URL slug
is an opaque auto-generated placeholder (e.g., `general-5`, `page-3`, `blank-1`).
Use the `resolvePageSlug` utility from `wix-extract.mjs`:

```sh
node -e "
  import { resolvePageSlug } from '${CLAUDE_PLUGIN_ROOT}/scripts/import/wix/wix-extract.mjs';
  console.log(JSON.stringify(resolvePageSlug('WIX_SLUG', 'PAGE_TITLE')));
"
```

If `resolvePageSlug` returns a different slug, use the new slug for the filename
and page path. Add the returned redirect line to REDIRECT_RULES for Step 5.

For **content pages**, check if the target path (slug) is in PROTECTED_PAGES.

If the page already exists, do NOT overwrite it. Add the page to SKIPPED_PAGES
with its extracted content (title, summary, and full text) so the owner can
review what was found. This preserves scaffolded functionality like contact
forms, review forms, and subscribe forms that would be lost if overwritten
with static text.

If the page does not exist, create a `.astro` file in `src/pages/` with:
- The page title in a `<title>` tag and `<h1>`
- A meta description derived from the page summary
- `BaseLayout` wrapper
- The full converted content from WebFetch or the API

If WebFetch returned an error or empty content for a specific page, retry once.
If it still fails, create the page with a `<!-- TODO: Review content from:
PAGE_URL -->` comment and add to FAILED_PAGES. Do not leave content pages empty
when WebFetch can extract them.

For **gallery pages**, add them to GALLERY_PAGES for processing in Step 4.

For **app-powered pages**, do NOT create a stub. Add to APP_PAGES for reporting
in Step 7. Do not try to replicate platform app functionality — booking, store,
and event features have industry-appropriate alternatives in `${CLAUDE_PLUGIN_ROOT}/docs/platforms/`.

### 3d — Create the homepage

If `index` is in PROTECTED_PAGES, do NOT overwrite the homepage. Add the
extracted homepage content to SKIPPED_PAGES so the owner can review it in
the summary.

If `index` is not in PROTECTED_PAGES, create `src/pages/index.astro` with
the actual homepage content. Use `BaseLayout`, include the site name as a
heading, and convert the extracted content to Astro-compatible HTML.

Download any hero images or logos found on the homepage to `public/images/` using
the same optimization pipeline as Step 2c.

### 3e — Generate navigation

Build the site navigation from NAV_LINKS (extracted in Step 3a). For each link:
- If the URL points to an imported page, use the local path (e.g., `/about`)
- If the URL points to an app-powered page, keep it but mark with a comment
- If the URL is external, keep the full URL

Update the navigation component in the site layout. Look for the nav element in
`src/layouts/BaseLayout.astro` or the equivalent layout file and replace the
default navigation links with the imported ones.

If NAV_LINKS is empty (WebFetch couldn't extract navigation), build navigation
from the STATIC_PAGES list — create a link for each content page that was
successfully imported.

# Step 2 — Import blog posts

Tell the owner:
> "I'm importing your blog posts now. I'll keep you posted on progress."

Ensure the image directory exists:

```sh
mkdir -p public/images/blog
```

Process each post in BLOG_POSTS that is not in SKIPPED_SLUGS.

### 2a — Extract the full post content

The extraction method depends on the platform:

**WordPress:** The content is already in the REST API response from Step 1b.
Use `content.rendered` (full HTML) and `excerpt.rendered`. To get the featured
image URL, fetch the media endpoint:

```sh
curl -s "SITE_URL/wp-json/wp/v2/media/FEATURED_MEDIA_ID"
```

The response contains `source_url` — the full-size image URL. Look up category
and tag names using the ID maps built in Step 1b.

**Squarespace (WXR export):** The content is already in the XML from Step 1b.
Use `<content:encoded>` (full HTML).

**Squarespace (RSS fallback):** The RSS feed URL is `COLLECTION_URL?format=rss`
where COLLECTION_URL is the blog collection path discovered in Step 1b (not
always `/blog` — may be `/news`, `/journal`, or any custom path). For posts in
the RSS feed, use the `<description>` or `<content:encoded>` field. For posts
NOT in the RSS feed (older than the most recent 10–20), use WebFetch on the
post URL with the extraction prompt below.

**Wix (MCP path, USE_WIX_MCP=true):** Use the Wix MCP server's `ExecuteWixAPI`
tool — the Ricos document converter returns clean output and eliminates
almost all of the HTML post-processing the Playwright/regex path needs.

1. Query all published posts in one call (paginate with `paging.cursor` if
   `pagingMetadata.cursors.next` is returned):

   ```
   ExecuteWixAPI POST https://www.wixapis.com/v3/posts/query
   body: {
     "fieldsets": ["URL", "CONTENT_TEXT", "SEO", "RICH_CONTENT"],
     "paging": { "limit": 100 }
   }
   ```

   Each result includes `title`, `slug`, `firstPublishedDate`, `excerpt`,
   `coverMedia` (with a direct `static.wixstatic.com` URL), `language`,
   `seoData`, and a `richContent` Ricos document.

2. For each post, convert the Ricos document to **HTML** (not Markdown — the
   Markdown target strips inline image nodes and only preserves captions).
   HTML lets the standard image pipeline swap CDN URLs to local paths during
   conversion:

   ```
   ExecuteWixAPI POST https://www.wixapis.com/ricos/v1/ricos-document/convert/from-ricos
   body: {
     "ricosDocument": <richContent>,
     "targetFormat": "HTML"
   }
   ```

3. **Token budget:** `ExecuteWixAPI` responses are capped at ~6,000 tokens.
   Convert at most 4 posts per call, and fall back to one post at a time for
   long posts. If a response is truncated, retry with a smaller batch.

4. Convert the returned HTML to Markdown using the rules in
   `references/docs/content-conversion.md` (Step 2b). Map fields:
   - `title` → `title`
   - `slug` → file slug
   - `firstPublishedDate` → `publishDate` (truncate to YYYY-MM-DD)
   - `excerpt` → `description` (or generate from body if empty)
   - `coverMedia.image.url` → `image` (download in Step 2c)
   - `seoData.tags` → tag/keyword frontmatter where applicable
   - `url.url` (or constructed `/post/<slug>`) → `syndication`

5. **Static pages and design tokens still need Playwright** — see Step 3b for
   pages and Step 5.5 for tokens. The Wix API does not expose editor pages.

If `ExecuteWixAPI` fails on a specific post, fall back to the Playwright path
below for that post only. Add the post to FAILED_POSTS only if both methods
fail.

**Wix (USE_WIX_MCP=false):** Use the RENDER_BACKEND driver (Step 1a.2) to
extract content and design tokens. WebFetch does not work on Wix pages.

Skip this check when RENDER_BACKEND=safari. Before the first extraction,
check if Playwright is installed and offer to install it if not:

```sh
npm ls playwright
```

If not installed, tell the owner:
> "I can extract your site's colors and fonts automatically, but I need to
> install a browser tool first (~150 MB). Want me to install it?"

If yes:

```sh
npm install playwright
npx playwright install chromium
```

If they decline, skip to the curl + regex fallback below (content only, no
design tokens).

Use the RENDER_BACKEND resolved in Step 1a.2:

- **safari** — batch every post URL in one invocation. Put the homepage URL
  first in the batch — design tokens are extracted from the first URL only:

  ```sh
  node references/scripts/import/browser/safari-driver.mjs "HOMEPAGE_URL" "POST_URL_1" "POST_URL_2" …
  ```

  Reads back as NDJSON, one line per post.

- **playwright** — one invocation per post:

  ```sh
  node references/scripts/import/wix/wix-playwright.mjs "POST_URL"
  ```

Each result is `{tokens, content}` where `content` has `{body, images, title, navLinks}`.
On the **first page** (homepage), save the `tokens` object — it contains
`--color-primary`, `--color-bg`, `--font-heading`, etc. that seed `global.css`.
For subsequent pages, skip redundant style extraction: with playwright, pass
`--content-only`; the safari driver already extracts tokens only for the first
URL in the batch, so no flag is needed there.

If the rendered backend fails on a specific page (Playwright timeout/crash, or
a Safari NDJSON line with `"error"`), fall back to curl + regex for that page
only:

```sh
curl -sL "POST_URL" > /tmp/wix-post.html
node references/scripts/import/wix/wix-extract.mjs post /tmp/wix-post.html
node references/scripts/import/wix/wix-extract.mjs meta /tmp/wix-post.html
```

If extraction returns empty content from either method, add the post to
FAILED_POSTS and continue. Do not stop the import for individual failures.

**Unknown platforms:** Use WebFetch on each post URL with this prompt:

> "Extract the full blog post content from this page. Return:
> 1. The post title (from the main heading, not browser title)
> 2. The publication date in YYYY-MM-DD format
> 3. The full body content converted to clean Markdown. Remove navigation,
>    headers, footers, sidebars, comments, social share buttons, and any
>    widget content. Keep headings, paragraphs, lists, blockquotes, and inline
>    links. Convert embedded images to Markdown image syntax with their src URLs.
>    Strip tracking links and JavaScript event handlers.
> 4. A 1–2 sentence description suitable for a meta description
> 5. Any tags or categories shown on the page"

If extraction returns an error or empty content, add the post to FAILED_POSTS
and continue. Do not stop the import for individual failures.

### 2b — Convert HTML to Markdown

For WordPress and Squarespace content that arrives as rendered HTML, follow the
HTML-to-Markdown conversion rules in
`references/docs/content-conversion.md`.

### 2c — Download and optimize images

Tell the owner (once, not per-post):
> "I'm downloading images from your website and converting them to a
> web-friendly format."

Follow the image optimization procedures in
`references/docs/content-conversion.md`, using `curl -L -s`
to download instead of `cp`.

**Platform-specific image URL handling:**
- WordPress: `source_url` from the media API response — use as-is
- Squarespace: `images.squarespace-cdn.com` URLs — strip `?format=NNNw` if NNN < 1200; replace with `?format=2500w` or remove the param
- Wix: `static.wixstatic.com` URLs — strip transform parameters from `/v1/` onward, append `?w=1200`

If the download fails, add to FAILED_IMAGES and omit `image` from frontmatter.

**Inline images:** Download with `SLUG-body-N.webp` naming and replace inline
URLs with local paths.

**Draft missing alt text (on-device).** After the images for this import are
downloaded, run `npm run ai-alt` once. On an Apple-Silicon Mac with Apple
Intelligence enabled, it drafts alt text **on-device** (nothing is uploaded)
for every image lacking one — including the `.webp` files just created — into
`image-alt.json`. On any other machine it's a no-op and nothing breaks.

### 2d — Assemble frontmatter and write the .mdoc file

Follow the `.mdoc` writing procedure in
`references/docs/content-conversion.md`. Use `-imported`
suffix for slug conflicts. Additionally, set:
- `syndication`: `["ORIGINAL_POST_URL"]` — the URL on the old platform, preserving provenance per ADR-0006
- Image alt text: where the **source HTML provides alt** (`<img alt="...">`),
  keep it. Where alt is **missing or empty**, look up the image's draft in
  `image-alt.json` (keyed by its `/images/...` path) and use it for the Markdown
  `![alt](path)` and the blog `imageAlt` frontmatter, then set that catalog
  entry's `status` to `reviewed`. Never override real authored alt with a draft.
  If there's no draft (no `fm`), leave alt as the source provided (or empty).

### 2e — Progress updates

After every 5 posts, tell the owner progress (see shared procedures).

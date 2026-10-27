---
name: import
description: "Import content from a website URL (WordPress, Squarespace, Wix, Webflow, GoDaddy, Ghost, Medium, Substack, Blogger, Shopify, Weebly, Tumblr, Micro.blog, WriteFreely, Carrd) or static site generator project. Use when the owner already has a website on another platform and wants its posts, pages, and images moved into Anglesite."
license: ISC
compatibility: "Designed for Claude Code / compatible agents operating inside an Anglesite project (Astro + Keystatic, Node >=22)."
allowed-tools: "WebFetch Bash(curl *) Bash(npx sharp-cli *) Bash(mkdir *) Bash(npm run build) Bash(npm install) Bash(npm run ai-alt) Bash(zsh *) Bash(node *) Bash(git add *) Bash(git commit *) Bash(git push *) Bash(ls *) Bash(wc *) Bash(grep *) Bash(find src/content/posts *) Bash(find public/images *) Bash(find */images *) Bash(find */public *) Bash(find */static *) Bash(find */source *) Bash(find */content *) Bash(find */docs *) Bash(find */_posts *) Bash(cp *) Write Read Glob Edit"
metadata:
  author: "David W. Keith"
  version: "1.9.0"
  source: "https://github.com/Anglesite/anglesite-skills"
  invocation: "user-facing"
  argument-hint: "[website URL or local path]"
---

Import blog posts, pages, and images from a live website URL. Supports
WordPress, Squarespace, Wix, Webflow, GoDaddy, Ghost, Medium, Substack,
Blogger, Shopify, Weebly, Tumblr, Micro.blog, WriteFreely, and Carrd. Detects
the platform automatically and uses the best extraction method. Migrates content
into the site's Markdoc collection, downloads images, and generates redirect
mappings so existing links and search rankings are preserved.

To convert an existing static site generator project (Hugo, Jekyll, Eleventy,
etc.) in the current directory, use `/anglesite:convert` instead.

## Shared guidance

Before reading the platform-specific doc, read `references/docs/import/hosted-platforms.md`
for HTML-to-Markdown conversion rules, image CDN handling, pagination patterns,
missing field fallbacks, and redirect best practices.

The platform-specific docs (`references/docs/import/PLATFORM.md`) cover only what's unique
to that platform — detection signals, API/feed endpoints, platform-specific HTML
elements, and CDN URL patterns. The shared docs cover everything common.

## Import principles

These apply to every import regardless of platform:

1. **Content accuracy over visual fidelity.** The first pass prioritizes getting all content moved correctly. Design tweaks come after.
2. **Download all images locally.** No external image dependencies — even stable CDNs. The site must render without any network calls to the old platform (ADR-0011).
3. **Generate descriptions from content.** If the platform has no excerpt field, use the first 1–2 sentences of the post body.
4. **Generate titles for untitled posts.** Microblog-style posts (Micro.blog, WriteFreely, Tumblr) need titles — use the first sentence, truncated at 60 characters.
5. **Preserve provenance.** Every imported post gets a `syndication` URL pointing to the original. This maintains the content trail (ADR-0006).
6. **Strip all third-party embeds.** YouTube, Twitter, Instagram embeds become comments noting what was there. No third-party JavaScript (ADR-0008).
7. **Don't replicate platform features.** Booking, store, events, forums can't be imported — redirect and recommend purpose-built replacements.
8. **Build must pass.** Fix every build error before presenting results to the owner (ADR-0012).
9. **Preserve scaffolded functionality.** If a scaffolded page already exists (contact form, review form, subscribe form, search), do not overwrite it — save the extracted content for the owner to review. Static text is easy to add back; working forms with backend infrastructure are not.
10. **Warn before cancellation.** For platforms where CDN URLs expire, explicitly warn the owner to verify all images are saved before they cancel their old account.

## Architecture decisions

- [ADR-0002 Keystatic CMS](references/docs/decisions/0002-keystatic-local-cms.md) — content lands as `.mdoc` files in `src/content/posts/`, the same format Keystatic edits
- [ADR-0006 IndieWeb POSSE](references/docs/decisions/0006-indieweb-posse.md) — imported posts get `syndication` URLs pointing back to their originals so the provenance trail is preserved
- [ADR-0008 No third-party JS](references/docs/decisions/0008-no-third-party-javascript.md) — tracking scripts, embedded iframes, and widget code must be stripped during import
- [ADR-0011 Owner ownership](references/docs/decisions/0011-owner-controls-everything.md) — imported content must not depend on the old platform to display correctly
- [ADR-0012 Verify first](references/docs/decisions/0012-verify-before-presenting.md) — build must pass after import before presenting results to the owner

Before every tool call or command that will trigger a permission prompt, explain
what you're about to do and why. The owner is non-technical.

## Pre-migration education

Before starting the import, surface the migration education prompts from `references/docs/education-prompts.md` section 7 ("Migration Flow"). Check `.site-config` for each `EDUCATION_<KEY>=shown` flag before surfacing. Share `THEME_OWNERSHIP`, `PRUNING`, and `PLATFORM_DESIGN` — frame as "a few things worth knowing before we start." Tailor the `THEME_OWNERSHIP` and `PLATFORM_DESIGN` copy to the detected platform name (e.g., "WordPress," "Squarespace"). Write the flags to `.site-config` after.

## Step 0 — Get the URL and check the project

### 0a — Get the URL

Ask the owner for their website URL if they didn't provide one as an argument.
The URL is the primary input — ask for it first before anything else.

Normalize: strip trailing slashes, ensure `https://`. Store as SITE_URL.

### 0b — Is this already an Anglesite project?

Use Glob to check for `src/content/config.ts` or `src/content.config.ts` (Astro 5
moved the content config; either path means Anglesite).

If either exists, this project has already been scaffolded. Read `.site-config` to
load `SITE_NAME` (and `OWNER_NAME` if it's set; don't prompt for it here — import
doesn't need it). Skip to Step 1.

### 0c — Scaffold if needed

If neither content config file exists, check the working directory:

**If it contains an SSG project** (Hugo, Jekyll, Eleventy, etc. config files),
tell the owner:

> "It looks like you have a [Platform] project here. To convert it to Anglesite,
> use `/anglesite:convert` instead. `/anglesite:import` is for importing from a
> website URL."

Stop.

**If the directory is essentially empty** (only dotfiles like `.git`), scaffold:

```sh
zsh references/scripts/scaffold.sh --yes .
```

No questions yet — the site name will be detected from the homepage in Step 3a, and the owner's name is collected later only if a downstream output needs it (see "On-demand owner name" in the `start` skill).

Save the minimum to `.site-config` using the **Write tool**:

```
SITE_TYPE=blog
SITE_NAME=My Site
DEV_HOSTNAME=mysite.local
AI_MODEL=(write your actual model name here)
EXPLAIN_STEPS=true
```

```sh
npm install
```

**If the directory has files but no recognized SSG**, tell the owner:

> "This directory has files in it but I don't recognize the project type. To
> import from a website, I'd recommend starting in an empty directory. Or use
> `/anglesite:convert` if this is a static site project."

Wait for guidance.

## Step 1 — Detect platform and discover content

Detect the source platform, fetch its content inventory, and set PLATFORM, POSTS, STATIC_PAGES, and the other discovery variables used by the steps below. Read `references/skills/import/platform-detection.md` and follow it.

## Step 2 — Import blog posts

Convert each discovered post to a Keystatic `.mdoc` file, download and optimize its images, and track redirects for Step 5. Read `references/skills/import/blog-posts.md` and follow it.

## Step 2.5 — Newsletter subscriber migration

If PLATFORM is `ghost` or `substack`, read
`references/skills/import/newsletter-migration.md` and follow the
instructions to offer newsletter migration.

## Step 3 — Handle static pages

Process STATIC_PAGES — extract homepage branding, then convert the remaining pages to Astro pages. Read `references/skills/import/static-pages.md` and follow it.

## Step 4 — Handle galleries and portfolios

If GALLERY_PAGES is empty, skip this step entirely.

For each gallery page, tell the owner:
> "I found a gallery with images on your [page name] page. Would you like me
> to download them all? I'll create a gallery page on your new site."

If they say yes:

Use WebFetch on the gallery page with this prompt:
> "List every image URL on this page. For each image, provide:
> 1. The full image URL (from the src attribute)
> 2. The alt text (if any)
> 3. Any caption or title text associated with the image"

Ensure the gallery image directory exists:

```sh
mkdir -p public/images/gallery
```

Download each image:

```sh
curl -L -s -o "public/images/gallery/PAGE-SLUG-NN.jpg" "IMAGE_URL"
```

Check file size and convert with `sharp-cli` if over 500KB (same as Step 2c).

After the gallery images are downloaded and converted, run `npm run ai-alt`
again (it's idempotent — it only drafts images that have no entry yet, so this
just covers the new gallery images). On a capable Mac it drafts on-device alt
text for any gallery image lacking it into `image-alt.json`; elsewhere it's a
no-op.

Create a gallery `.astro` page in `src/pages/` with:
- The page title and meta description
- `BaseLayout` wrapper
- A responsive CSS grid layout displaying all downloaded images
- Each image using Astro's `<img>` tag with the local path and alt text — where
  the source had no alt, use the draft from `image-alt.json` (keyed by the
  image's `/images/gallery/...` path) and treat that entry as `reviewed`; keep
  any alt the source provided
- A note that the owner can rearrange or edit in the source file

## Step 5 — Generate redirect mappings

Read the existing `public/_redirects` file. Append new rules — do not overwrite
existing entries.

The redirect pattern depends on the platform's URL structure:

**WordPress:** WordPress has multiple permalink structures. Use the actual URLs
from the API response (`link` field) to determine the pattern.

Common patterns:
```
# "Day and name" or "Month and name" permalinks
/YYYY/MM/DD/slug/ /blog/slug 301
/YYYY/MM/slug/ /blog/slug 301

# "Post name" permalink
/slug/ /blog/slug 301

# Default (query parameter)
/?p=123 /blog/slug 301
```

Generate a redirect for each post using the actual old URL path.

**Squarespace:**

Squarespace blog URLs depend on the collection name and permalink format. The
collection may not be `/blog` — it could be `/news`, `/journal`, etc. Some sites
use date-based URLs like `/news/YYYY/M/slug`. Use the actual URLs from the RSS
feed or WXR export.

```
# Same path (collection is already /blog)
/blog/slug /blog/slug 200

# Different collection name
/news/slug /blog/slug 301

# Date-based URLs
/news/2026/3/slug /blog/slug 301
```

If old and new paths match, use `200` (passthrough). If they differ, use `301`.

**Wix:**
```
/post/slug /blog/slug 301
```

### Static page redirects

For pages where the old and new URL paths match, no redirect is needed.

For pages with different paths (including opaque Wix slugs renamed in Step 3c):
```
/old-path /new-path 301
```

Include any redirect rules generated by `resolvePageSlug` in Step 3c. These
handle opaque Wix slugs like `general-5` that were renamed to match page titles.

For app-powered pages with no equivalent yet, use a temporary redirect:
```
/app-page / 302
```

Note the 302s in the output — they should be updated to 301s once the owner
sets up the replacement tool.

### Common platform paths

Add trailing-slash redirects as needed:
```
/blog/ /blog 301
```

Write the updated `_redirects` file, preserving all existing rules and comments.

For every rule appended in this step, also append a row to `.anglesite/url-map.csv`
(create the directory and file if missing) so `/anglesite:redirects review` can
walk the owner through what was added. The format is `from,to,status,note,source`.
Use `import:<platform>` for the `source` column (e.g., `import:wordpress`,
`import:wix`) and a short `note` describing why the rule was added — common
values are `platform-rename`, `wix-opaque-slug`, `date-permalink-collapse`, and
`app-page-placeholder` (302s pointing at `/` for booking, store, events, etc.,
which the owner should revisit once they pick a replacement tool).

## Step 5.5 — Apply design tokens (rendered backend)

If a rendered backend (Safari or Playwright) captured tokens and design
tokens were extracted from the homepage in Step 2a, apply them to
`src/styles/global.css`:

1. Read the current `global.css`
2. For each non-null token from the rendered backend's output, replace the
   corresponding CSS custom property value:
   - `--color-primary`, `--color-accent`, `--color-bg`, `--color-text`, `--color-muted`
   - `--font-heading`, `--font-body`
3. Write the updated file

Tell the owner:
> "I extracted your site's brand colors and fonts from the original design:
>
> **Colors:** primary [hex], accent [hex], background [hex]
> **Fonts:** headings in [font], body text in [font]
>
> These have been applied to your new site's stylesheet."

If the rendered backend failed on the homepage and no tokens were captured,
skip this step. The owner can set up colors and fonts later via
`/anglesite:design-interview`.

This step now applies to Squarespace imports too — extract homepage tokens
with `--styles-only` via RENDER_BACKEND when available.

## Step 6 — Build and verify

Follow the build-and-verify procedure in
`references/docs/content-conversion.md`.

After a clean build, also check for remaining external image dependencies:

```sh
grep -rE "wixstatic\.com|squarespace-cdn\.com|wp-content/uploads" dist/ --include="*.html"
```

If any references to the old platform's CDN appear in the built HTML, find the
source files and replace with locally downloaded images (ADR-0008, ADR-0011).

## Step 7 — Present the results

Give the owner a plain-English summary:

> "Your content has been imported! Here's what happened:
>
> **Blog posts:** 21 of 23 imported successfully
> **Images:** 19 downloaded and optimized
> **Redirects:** 27 redirect rules added
> **Pages imported:** 4 with full content (About, FAQ, Services, Contact)
> **Homepage:** Updated with your actual content and branding
> **Navigation:** Set up with links to all your pages
>
> **A couple of things to know:**
> - 2 posts couldn't be fetched (listed below). You can add them manually
>   in Keystatic.
> - Your booking page used [Platform]'s scheduling tool. I've set up a
>   redirect for now — we can set up an alternative together.
>
> The site builds correctly and all the redirects are in place. Your search
> rankings should carry over once you publish.
>
> **One more thing:** This first pass focuses on getting all your content
> moved over accurately. The formatting and layout might not match your old
> site exactly — that's normal. Once you've had a chance to look through it,
> just let me know what you'd like adjusted and I'll make design tweaks
> until it looks right."

List FAILED_POSTS, FAILED_PAGES, and FAILED_IMAGES so the owner knows what needs attention.

For each SKIPPED_PAGES entry, tell the owner what was found on their old site and
that the existing page was preserved:
> "Your **[page name]** page already has [describe existing functionality, e.g.,
> 'a contact form']. I kept it as-is. Here's what I found on your old site for
> that page: [extracted content summary]. Let me know if you'd like me to add
> any of that to the existing page."

For each APP_PAGES entry, suggest a replacement:
- Booking/scheduling → "Cal.com or Calendly integrate well. See `references/docs/platforms/`."
- Store/e-commerce → "Square or Shopify work great. See `references/docs/platforms/`."
- Events → "I can build a custom events page for you."
- Contact form → "I can add a simple email link, or we can set up a form service."
- Forum/members → "This would need a separate platform — let's discuss options."

## Step 8 — Save a snapshot

```sh
git add -A
```

```sh
git commit -m "Import content from PLATFORM (N posts, N pages)"
```

Replace PLATFORM and N with actual values.

Read `GITHUB_REPO` from `.site-config`. If set, push to GitHub:

```sh
git push origin draft
```

If the push fails, log the issue but don't block the import.

## Step 9 — Offer to deploy

Ask:
> "Would you like to publish the imported content now? I'll run the security
> check first. Or you can review it in Keystatic first — just type
> `/anglesite:deploy` when you're ready."

If they say yes, run `/anglesite:deploy`.

## Platform reference docs

Platform-specific import guides are in `references/docs/import/`. Each doc covers:
- How to detect the platform
- API/feed endpoints and authentication
- HTML structure and CDN URL patterns
- Content conversion notes
- Common issues and gotchas

See `references/docs/import/README.md` for the full index.

## Keep docs in sync

After this skill runs, update `docs/architecture.md` to note that content was
imported and the date. Example:
> "Content imported from [Platform] on YYYY-MM-DD. N posts, N pages. Redirects
> in `public/_redirects`."

## Edge cases

See `references/docs/content-conversion.md` for shared edge
cases (large images, multilingual content, slug conflicts).

### No blog on the site

If BLOG_POSTS is empty after discovery:
> "Your website doesn't appear to have a blog. I can still import your pages
> and images, and set up redirects."

Continue with Steps 3–5 for pages, galleries, and redirects only.

### Platform app pages

Booking, store, event, forum, and member pages cannot be meaningfully imported —
the content depends on the platform's runtime infrastructure. Redirect to home
(302) and present replacement options in Step 7.

### WordPress REST API is disabled

Some WordPress sites disable the REST API. If `/wp-json/` returns 403 or 401,
fall back to the RSS feed (`/feed/`) which usually contains full post content,
then use WebFetch for anything not in the feed.

### Squarespace images disappear after cancellation

Warn the owner before they cancel their Squarespace subscription:
> "Important: the images on your Squarespace site will stop being available
> after you cancel your subscription. Make sure I've downloaded everything
> before you cancel. Let me verify all images are saved locally."

Run the build verification (Step 6) to confirm no external image URLs remain.

### WordPress custom post types

Some WordPress sites use custom post types (portfolios, testimonials, products).
The REST API may expose these at `/wp-json/wp/v2/TYPE_NAME`. If the categories
or tags response mentions custom taxonomies, probe for custom endpoints. Report
any custom post types to the owner and ask how they'd like to handle them.

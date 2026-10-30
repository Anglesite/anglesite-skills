# Step 1.5 — Extract visual identity

Tell the owner:
> "Before converting your content, I'm reading your site's design — colors, fonts,
> logo, and layout — so the converted site keeps your existing look and feel."

The scaffold creates generic defaults (blue `#2563eb`, system fonts, plain text
header). This step replaces those with values extracted from the source project.

### 1.5a — Find and read source CSS

Use Glob to find CSS files in the source project. Common locations:

| Platform | CSS locations |
| --- | --- |
| Hugo | `assets/css/`, `static/css/`, `themes/*/assets/css/` |
| Jekyll | `_sass/`, `assets/css/`, `css/` |
| Next.js | `styles/`, `src/styles/`, `app/globals.css` |
| Gatsby | `src/styles/`, `src/css/` |
| Nuxt | `assets/css/`, `assets/styles/` |
| Docusaurus | `src/css/` |
| VuePress | `.vuepress/styles/` |
| MkDocs | `docs/stylesheets/` |
| Eleventy | `src/_includes/css/`, `src/css/`, `css/`, `_includes/css/` |
| Hexo | `themes/*/source/css/` |

Read all CSS files found. Extract these design tokens:

**Colors** — Look for CSS custom properties (`--color-*`, `--bg-*`, `--text-*`,
`--link-*`, `--accent-*`), or recurring color values in `color:`, `background:`,
`background-color:`, `border-color:` properties. Identify:
- Background color (body/html `background` or `background-color`)
- Text color (body/html `color`)
- Link/primary color (`a` color or most prominent accent)
- Heading color (if different from text)
- Muted/secondary text color
- Surface/card background color
- Border color

**Fonts** — Look for `font-family` on `body`, `html`, headings. Note whether
fonts are system fonts, self-hosted (look for `@font-face`), or external (Google
Fonts links — these will be self-hosted per ADR-0008).

**Layout** — Look for `max-width` on the main content container. Note the value
to apply to `--max-width`.

**Dark mode** — Check for `@media (prefers-color-scheme: dark)` or a
`.dark`/`[data-theme="dark"]` selector. If present, note the dark palette.

**Accessibility** — Check for `@media (prefers-contrast: more)`,
`prefers-reduced-motion`, or `color-scheme` meta declarations.

### 1.5b — Read layout templates

Use Glob to find layout/template files. Common locations:

| Platform | Layout locations |
| --- | --- |
| Hugo | `layouts/_default/baseof.html`, `layouts/partials/` |
| Jekyll | `_layouts/default.html`, `_includes/` |
| Next.js | `src/app/layout.tsx`, `pages/_app.tsx`, `components/Layout.tsx` |
| Gatsby | `src/components/layout.js`, `src/templates/` |
| Nuxt | `layouts/default.vue`, `components/` |
| Docusaurus | `src/theme/Layout/`, `src/components/` |
| VuePress | `.vuepress/theme/layouts/` |
| MkDocs | `overrides/` |
| Eleventy | `src/_includes/`, `_includes/`, `layouts/` |
| Hexo | `themes/*/layout/` |

Read the main layout file. Extract:

**Header structure:**
- Logo image path and alt text (e.g., `<img src="/img/logo.svg">`)
- Site title text or element
- Navigation links (names and hrefs)

**Footer structure:**
- Social media links (platform and URL for each)
- Copyright text or license information
- Any badges or certifications

**Meta tags:**
- `color-scheme` meta tag value
- Any additional meta tags worth preserving

### 1.5c — Read data/config files

Many SSGs store site metadata in data files:

| Platform | Metadata locations |
| --- | --- |
| Hugo | `config.toml` (`[params]`), `data/` |
| Jekyll | `_config.yml`, `_data/` |
| Next.js | `package.json`, custom config files |
| Gatsby | `gatsby-config.js` (`siteMetadata`) |
| Nuxt | `nuxt.config.ts` |
| Eleventy | `src/_data/`, `_data/` (JSON/JS files) |
| Hexo | `_config.yml` |

Look for:
- Site title, description, author name
- Social media handles/URLs
- Logo file reference
- License or copyright text

### 1.5d — Copy static assets

Use Glob to find logo files, favicons, and avatar images in the source project:

```sh
find . -maxdepth 4 -type f \( -name "logo.*" -o -name "favicon.*" -o -name "avatar.*" -o -name "apple-touch-icon.*" \) -not -path "*/node_modules/*" -not -path "*/_site/*" -not -path "*/dist/*"
```

Copy found assets to `public/`:

```sh
cp SOURCE_LOGO public/logo.EXT
```

If a `favicon.svg` or `favicon.ico` is found, copy it to `public/`. The Anglesite template ships without a default favicon, so this populates the missing icon.

### 1.5e — Apply extracted design to Anglesite

**Update `src/styles/global.css`** — Use the Edit tool to replace the `:root`
CSS custom properties block with the extracted values. Map source colors to
Anglesite tokens:

| Anglesite token | Source value |
| --- | --- |
| `--color-primary` | Link color or main accent |
| `--color-accent` | Secondary accent (or derive from primary) |
| `--color-bg` | Body background |
| `--color-text` | Body text color |
| `--color-muted` | Secondary/lighter text |
| `--color-surface` | Card/section background |
| `--color-border` | Border color |
| `--font-heading` | Heading font-family |
| `--font-body` | Body font-family |
| `--max-width` | Content max-width (convert to rem if in px: divide by 16) |

If the source uses external fonts (Google Fonts), download the font files and
add `@font-face` declarations at the top of `global.css` with the files in
`public/fonts/`. Never link to external font services (ADR-0008).

If the source has dark mode support, add a `@media (prefers-color-scheme: dark)`
block after the `:root` block with the dark palette mapped to the same tokens.

If the source has `prefers-contrast: more` or `prefers-reduced-motion` support,
add those media queries as well.

If the source has custom blockquote, code, or other element styling that differs
significantly from the scaffold defaults, add those styles to the appropriate
sections of `global.css`.

**Update `src/layouts/BaseLayout.astro`** — Use the Edit tool to update:

1. **Header**: If the source has a logo, add an `<img>` tag. If it has
   navigation, add a `<nav>` element with the extracted links. Structure:
   ```html
   <header class="h-card">
     <a href="/" class="p-name u-url">
       <img src="/logo.EXT" alt="SITE_NAME logo" width="W" height="H" />
       SITE_NAME
     </a>
     <nav>
       <a href="/about/">About</a>
       <a href="/blog/">Blog</a>
     </nav>
   </header>
   ```

2. **Footer**: If the source has social links, add them. If it has a license,
   include it. Structure:
   ```html
   <footer>
     <nav class="social-links">
       <a href="URL" rel="me">Platform</a>
     </nav>
     <p>&copy; YEAR HOLDER</p>
   </footer>
   ```

   For `HOLDER`, prefer `OWNER_NAME` from `.site-config` if it's set. If it's
   not, **this is a legitimate on-demand trigger** — ask the owner once: "What
   name should appear on the copyright line — your name, or the business
   name?" Save the answer to `.site-config` as `OWNER_NAME` (or use `SITE_NAME`
   if they pick the business name and want to skip personal-name collection
   entirely). See "On-demand owner name" in `${CLAUDE_PLUGIN_ROOT}/skills/start/SKILL.md`.

3. **Meta tags**: If the source had `<meta name="color-scheme" content="dark light">`,
   add it to the `<head>`.

4. **HTML lang**: If the source used a different `lang` attribute, update it.

**Add header/footer CSS** if needed — add styles for the nav and social links to
`global.css`:

```css
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

header nav {
  display: flex;
  gap: var(--space-md);
}

header nav a {
  text-decoration: none;
  color: var(--color-text);
}

.social-links {
  display: flex;
  gap: var(--space-sm);
}
```

**Fallback**: If no CSS or layout files are found (unlikely but possible),
skip this step and proceed with scaffold defaults. Tell the owner:
> "I couldn't find design files in your project. The site will use default
> styling — you can customize colors and fonts anytime by asking me."

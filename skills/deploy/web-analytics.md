# Step 6 — First deploy: Wire up Web Analytics

The site is live, but the Cloudflare Web Analytics beacon won't fire until `CF_WEB_ANALYTICS_TOKEN` is written into `.site-config` and a build picks it up. **Doing this now means launch-week traffic (usually the most interesting traffic) actually gets recorded** — if we wait until the owner asks for `/anglesite:stats`, the beacon misses days or weeks of real visitors.

Read `CF_WEB_ANALYTICS_TOKEN` from `.site-config`. If it's already set, skip this step entirely — the beacon is wired up.

Tell the owner: "Now let's turn on Cloudflare's privacy-friendly analytics so visitors get counted from day one. It's free, cookieless, no GDPR banner needed. The beacon is already in your site code — we just need to enable it on the Cloudflare side and copy a public site tag back."

Open the Web Analytics dashboard: `https://dash.cloudflare.com/?to=/:account/web-analytics`

Walk them through:
1. Click **Add a site**
2. **Hostname** — enter the site's live hostname:
   - If `SITE_DOMAIN` is in `.site-config`, use that (e.g., `www.example.com`)
   - Otherwise, use the `CF_PROJECT_NAME.<account>.workers.dev` URL Wrangler printed in Step 3
3. Leave the "Enable on this site" toggle off (the beacon is injected by the layouts, not by Cloudflare's auto-injector — leaving it off prevents a double beacon)
4. Click **Done**
5. Cloudflare shows a JS snippet that looks like `<script ... data-cf-beacon='{"token":"abc123..."}'></script>`. Copy the **token value only** — the 32-character hex string between `"token":"` and `"}'`

Tell the owner: "Paste the token here. It's safe to share — every visitor sees it in your site's HTML anyway. It's not an API key."

Once they paste it, validate the shape (32 hex characters) and save it to `.site-config` with the Write tool by adding `CF_WEB_ANALYTICS_TOKEN=<value>`. Do not paste the token into chat from your side and do not write it anywhere outside `.site-config`.

If the owner declines or wants to skip, tell them: "No problem — you can wire it up later by running `/anglesite:stats` and it'll walk you through the same steps. Just know that any traffic before then won't be counted."

### Rebuild and redeploy so the beacon goes live

The layouts inject the beacon at build time, so the site needs one more deploy with the token in place. Reuse the publish flow:

```sh
npm run deploy
```

Tell the owner: "Your site is now reporting real-browser pageviews to Cloudflare Web Analytics. The first numbers usually show up within a few minutes."

### Where to read the numbers

"You can check anytime two ways:"

- `/anglesite:stats` — plain-language summary right here in chat (page views, top pages, busiest day, referrers)
- Dashboard for richer charts: `https://dash.cloudflare.com/?to=/:account/web-analytics`

Remind them of the goals they shared during `/anglesite:start`: "You said you wanted [goal]. Once you've been live for a few weeks, check analytics to see if visitors are finding the pages that matter — like your [menu/services/portfolio] page."

### Post-publish education

After the first successful deploy, surface the post-publish education from `${CLAUDE_PLUGIN_ROOT}/docs/education-prompts.md` section 6 ("Post-Publish Success Message"). Check `.site-config` for each `EDUCATION_<KEY>=shown` flag before surfacing. Share `SEO_TIMELINE`, `INDEXING_DELAY`, and `DISTRIBUTION` — the owner is most receptive right after launch, and these set realistic expectations. Write the flags to `.site-config` after.

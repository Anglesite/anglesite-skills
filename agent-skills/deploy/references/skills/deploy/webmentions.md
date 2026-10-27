# Step 2a-webmention — Send webmentions (conditional on Webmention being enabled)

Read `INDIEWEB_WEBMENTION` from `.site-config`. If not `true`, skip this step entirely — the site has no Webmention endpoint set up (`/anglesite:indieweb`).

If `true`, run the build-time webmention sender against the built output:

```sh
npm run ai-webmention-send
```

This scans blog posts and notes for outbound links in their content, discovers each target's Webmention endpoint, and sends one — closing the loop with the site's own receiving endpoint (ADR-0020) instead of leaving sending to a third-party tool. Each (post, link) pair is attempted once, ever; state is tracked in `webmention-sent.json` at the project root. Never blocks the deploy — it only logs a summary line (e.g. "3 sent, 12 already sent, 1 no endpoint"). If `webmention-sent.json` changed, it needs to be committed along with any other site changes so the next deploy doesn't re-attempt the same pairs.

### When the gate runs

a14y audits a live URL, so the build needs to be served. Use the preview server (it serves `dist/` from Step 1):

```sh
npm run preview -- --port 4321 &
```

Wait a couple of seconds for it to come up, then run the audit against it:

```sh
npm run ai-a14y -- --url http://localhost:4321 --json
```

Then stop the preview server (kill the background process).

Apply the same severity logic as the a11y gate:

- Exit code `0` — clean, proceed
- Exit code `1` — score below `A14Y_FAIL_UNDER` (or below a14y's default threshold). Pause the deploy, present findings in plain English (translate rule IDs into user-visible impact), offer fixes, then rebuild and re-run.
- Exit code `127` — a14y not installed. Tell the owner once: "I need to install the a14y CLI to check agent readability. It's a one-time install." Run `npm install --save-dev a14y`, then continue.

### Warn-only mode

If `A14Y_WARN_ONLY=true` is set in `.site-config` (or the owner passes `--warn-only`), the audit always exits `0` regardless of the score, but the report is still surfaced. Use this when a site is being brought up to a healthy a14y score so deploys aren't blocked while the backlog clears.

### Threshold

`A14Y_FAIL_UNDER=80` (or any 0–100 integer) sets the minimum score the gate enforces. If unset, the gate uses a14y's CLI default. Suggest a starting threshold of `80` to the owner the first time they enable the gate, and explain it's a floor — not a target.

If the owner passes `--skip-a14y`, skip this step.

---
status: accepted
date: 2026-07-26
decision-makers: [Anglesite maintainers]
---

# Snapshot social embeds into the owner's repo instead of rendering them remotely

## Context and Problem Statement

Owners want to embed content from social platforms — a tweet quoted in a blog post, the
post a reply is replying to. ADR-0008 blocks the normal way of doing this: every platform's
embed is a `<script>` from the platform's own CDN that tracks every visitor who loads the
page, whether or not they interact with it.

ADR-0008's stated alternative was "static screenshots with links to original posts". That
is honest but manual, produces no machine-readable citation, and degrades the IndieWeb
reply-context markup (`u-in-reply-to`, `h-cite`) that receiving Webmention endpoints parse.
Anglesite needed a real embed story that keeps ADR-0008 intact.

There is a second, less obvious problem. This is *legacy* social content: the premise is
that these platforms are decaying. Any design that fetches from the platform at render time
— or at build time — has bet the owner's archive on that platform's continued goodwill.
X's oEmbed endpoint, Instagram's API, and the platforms themselves may not outlive the
sites that cite them.

## Decision Drivers

* ADR-0008 — no third-party JavaScript, and no new exception if it can be avoided
* Visitor privacy — a hotlinked image is still a tracked request, not just a script
* ADR-0011 — the owner controls everything; the artifact must live in their repo
* Git is the source of truth — the app must never be the only way to edit a site
* Durability — an embed must survive the platform deleting the post or retiring its API
* Build determinism — a deploy must not fail because a remote is down
* IndieWeb correctness — reply context must emit parseable `h-cite` microformats

## Considered Options

* **Snapshot at author time into the owner's git repo** (chosen)
* **Cloudflare Zaraz server-side rendering of embeds**
* **`astro-embed` as shipped** (fetch at build time, hotlink media)
* **Status quo** — static screenshots with links, per ADR-0008's original table

## Decision Outcome

Chosen: **snapshot at author time into the owner's git repo.**

A CLI fetches the post once, when the owner adds it, and writes a normalized record to
`src/embeds/<slug>.json` plus its media to `public/embeds/<slug>/`. Both are committed. At
build time a Markdown plugin swaps a bare URL for a first-party card rendered from that
committed record; the same renderer serves `inReplyTo` / `bookmarkOf` / `likeOf` reply
context as `h-cite`. **The build makes no network request at all.**

Consequences that follow directly:

* The rendered card is first-party HTML and first-party images, so **no CSP allowlist entry
  and no new ADR-0008 exception are required**. A correct implementation needs neither —
  that is the test of whether this preserves the ADR or quietly widens it.
* Media is downloaded and self-hosted rather than hotlinked. Hotlinking would still leak
  every visitor's IP and `Referer` to the platform, which is the exact tracking ADR-0008
  exists to prevent, and it would force a per-platform `img-src` allowlist.
* An embed keeps rendering after the platform deletes the post or retires its API, because
  the content is a file in the owner's repo.
* A URL with no snapshot degrades to an ordinary working link. A platform being down,
  rate-limiting, or blocking automation can never fail a build.
* Inline video stays **opt-in** (`EMBED_VIDEO_INLINE`). The default card is a link with a
  self-hosted thumbnail. The opt-in widens `frame-src` to exactly `youtube-nocookie.com`
  and loads the player only when it scrolls into view.
* A pre-deploy scan rule fails the deploy if built output references platform media hosts,
  so the privacy property is enforced mechanically rather than by convention (ADR-0007).

### Rejected: Cloudflare Zaraz SSR

Zaraz's server-side rendering of embeds genuinely does solve the third-party-JavaScript
problem — Cloudflare fetches the post at the edge, strips the platform's scripts, and
proxies images through the owner's domain. On the narrow ADR-0008 question it is a valid
answer, and it was the specific proposal this decision was asked to evaluate.

It was rejected because it solves the problem **at request time, at the edge**, so the
rendered artifact exists nowhere the owner can see, keep, or move:

| | Zaraz SSR | Snapshot |
|---|---|---|
| Third-party JS on page | None | None |
| Third-party image requests | Proxied via the owner's domain | Self-hosted |
| Platform coverage | X + Instagram only | Any URL (Open Graph) + per-platform adapters |
| Visible in `astro dev` / `preview` | **No** | Yes |
| Works off Cloudflare | **No** | Yes |
| Configuration lives in | The Cloudflare dashboard, per zone | The owner's git repo |
| Survives the platform deleting the post | No | **Yes** |
| Survives the platform retiring its API | No | **Yes** |

The dashboard-versus-repo row is the one that decides it: a per-zone dashboard toggle is
exactly the kind of invisible, unportable configuration ADR-0011 and the git-is-the-source-
of-truth rule exist to keep out of a site. Zaraz is recorded here as a rejected alternative,
not a fallback.

### Rejected: `astro-embed` as shipped

`astro-embed` renders X, Bluesky, and Mastodon posts without client-side JavaScript, which
is most of the way there, and it was already a declared dependency. But it fetches from the
platform on **every build** and hotlinks the platform's images. That makes builds
network-dependent and non-deterministic, leaves the visitor-tracking image requests in
place, and means a deleted upstream post silently empties the embed on the next rebuild —
the durability failure this decision most wants to avoid. The dependency was removed.

### Rejected: status quo (static screenshots)

Manual, produces no machine-readable citation, and gives reply context no `h-cite` markup.
It survives here only as the documented escape hatch for platforms that cannot be
snapshotted automatically (Instagram blocks automated requests and gates its API behind a
Meta app token), where the owner supplies the screenshot by hand.

## Consequences

* Good, because visitors are not tracked by any embed, by script or by image
* Good, because the CSP and ADR-0008's exception list are untouched
* Good, because an embed outlives the platform it came from
* Good, because builds are hermetic and cannot fail on a remote
* Good, because reply context becomes parseable `h-cite` instead of a bare link
* Bad, because capturing a snapshot is an explicit step — pasting a URL is not enough
* Bad, because committed media grows the site repo
* Bad, because a snapshot is a point-in-time capture and will not reflect a later-edited
  post (arguably correct for a citation, but it is a behaviour change from live embeds)
* Bad, because each platform adapter is a small ongoing maintenance liability; the generic
  Open Graph fallback bounds the blast radius, since an adapter breaking degrades that
  platform to a link card rather than to a build failure

### Confirmation

The pre-deploy scan fails any deploy whose built output references a known platform media
host in a resource-loading context (`src`, `srcset`, CSS `url()`), and the renderer refuses
any asset path that is not repo-relative. Per ADR-0007 the owner cannot override the scan.

## More Information

Implemented in `Anglesite-app` (the template is app-owned):
[Anglesite/Anglesite-app#979](https://github.com/Anglesite/Anglesite-app/pull/979),
issue [#682](https://github.com/Anglesite/Anglesite-app/issues/682). The evaluation this
ADR records is set out in full in that repo's
`docs/superpowers/specs/2026-07-25-privacy-preserving-embeds-design.md`.

Source for the rejected option:
[Zaraz supports server-side rendering of embeds](https://blog.cloudflare.com/zaraz-supports-server-side-rendering-of-embeds/).

Related: ADR-0007 (mandatory pre-deploy scans), ADR-0008 (no third-party JavaScript),
ADR-0011 (owner controls everything), ADR-0006 (IndieWeb principles).

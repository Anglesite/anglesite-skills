# Step 4.5 — Update the homepage

The scaffold placeholder in `src/pages/index.astro` must be replaced with
content appropriate for the site type.

Read `SITE_TYPE` from `.site-config`.

**If `SITE_TYPE=blog`:** Replace `src/pages/index.astro` with a blog listing
homepage that shows recent posts. Read `POST_URL_PREFIX` from `.site-config`
to determine the correct link prefix.

Use the **Edit tool** to replace the entire file content with:

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import { getCollection } from "astro:content";

const allPosts = await getCollection("posts", ({ data }) => {
  return import.meta.env.PROD ? !data.draft : true;
});

const posts = allPosts.sort(
  (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime(),
);
---

<BaseLayout title="SITE_NAME" description="SITE_DESCRIPTION">
  <ul class="post-list">
    {
      posts.map((post) => (
        <li class="h-entry">
          <a href={`/POST_URL_PREFIX/${post.id}/`} class="u-url">
            <h2 class="p-name">{post.data.title}</h2>
          </a>
          <time
            class="dt-published"
            datetime={post.data.publishDate.toISOString()}
          >
            {post.data.publishDate.toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </time>
          <p class="p-summary">{post.data.description}</p>
        </li>
      ))
    }
  </ul>
</BaseLayout>
```

Replace `POST_URL_PREFIX` with the value from `.site-config`:
- If `POST_URL_PREFIX=blog`, the href becomes `` `/blog/${post.id}/` ``
- If `POST_URL_PREFIX=` (empty), the href becomes `` `/${post.id}/` ``

Replace `SITE_NAME` with the value from `.site-config` and `SITE_DESCRIPTION`
with a brief description of the site.

**If `SITE_TYPE` is not `blog`:** Keep the scaffold placeholder for now — the
owner will customize the homepage during the design phase.

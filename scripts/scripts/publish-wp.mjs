// Publish articles/**/*.md to a WordPress site via REST API.
// GitHub is the source of truth — WP posts are overwritten.
// Graceful no-op if WP secrets are not set.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { marked } from "marked";

// ============ Config ============
const WP_URL = (process.env.WP_URL || "").replace(/\/+$/, "");
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const ARTICLE_DIR = process.env.ARTICLE_DIR || "articles";
const ASSETS_DIR = process.env.ASSETS_DIR || "assets";
const GITHUB_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const BRANCH = process.env.GITHUB_REF_NAME || "main";
const SYNCED_TAG = process.env.WP_SYNC_TAG || "_notion-synced";
const POST_STATUS = process.env.WP_POST_STATUS || "publish";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30_000);
const DRY_RUN = process.env.WP_DRY_RUN === "true";

if (!WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.log(
    "[publish-wp] WP_URL / WP_USER / WP_APP_PASSWORD not all set — skipping WP publish."
  );
  process.exit(0);
}

const AUTH =
  "Basic " +
  Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`, "utf8").toString("base64");

// Raw URL base for rewriting ../../assets/xxx → raw.githubusercontent.com/owner/repo/branch/assets/xxx
const RAW_BASE = GITHUB_REPO
  ? `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}`
  : null;

// ============ Helpers ============
function log(...args) {
  console.log("[publish-wp]", ...args);
}
function warn(...args) {
  console.warn("[publish-wp]", ...args);
}

async function wpFetch(pathname, { method = "GET", body, headers = {} } = {}) {
  const url = `${WP_URL}/wp-json/wp/v2${pathname}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: AUTH,
        Accept: "application/json",
        ...(body && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      body:
        body instanceof FormData
          ? body
          : body
          ? JSON.stringify(body)
          : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, body: text };
  const block = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fm = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    let val = m[2];
    try {
      val = JSON.parse(val);
    } catch {
      /* keep raw */
    }
    fm[m[1]] = val;
  }
  return { fm, body };
}

// Walk articles/ and collect .md files (skip auto-generated index files)
function listMarkdownFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const skip = new Set(["README.md", "TAGS.md"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md") && !skip.has(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// Rewrite ../../assets/xxx → raw.githubusercontent.com/owner/repo/branch/assets/xxx
function rewriteAssetUrls(md) {
  if (!RAW_BASE) return md;
  // Handles ![](../../assets/foo) and <img src="../../assets/foo">
  return md
    .replace(/\]\((\.\.\/\.\.\/assets\/[^)]+)\)/g, (_, p) => `](${RAW_BASE}/${p.replace(/^\.\.\/\.\.\//, "")})`)
    .replace(/<img\s+[^>]*src=["'](\.\.\/\.\.\/assets\/[^"']+)["'][^>]*>/g, (full, p) =>
      full.replace(p, `${RAW_BASE}/${p.replace(/^\.\.\/\.\.\//, "")}`)
    );
}

function firstInlineAsset(md) {
  const m = md.match(/\]\(\.\.\/\.\.\/assets\/([^)]+)\)/);
  return m ? m[1] : null;
}

function guessMime(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
  }[ext] || "application/octet-stream";
}

// ============ Term (category / tag) helpers ============
const termCache = { category: new Map(), post_tag: new Map() };

async function ensureTerm(type, name) {
  if (!name) return null;
  const key = name.toLowerCase();
  const cache = termCache[type];
  if (cache.has(key)) return cache.get(key);

  // type → endpoint
  const endpoint = type === "category" ? "/categories" : "/tags";

  // Try to find existing
  const found = await wpFetch(
    `${endpoint}?search=${encodeURIComponent(name)}&per_page=100`
  );
  const match = Array.isArray(found)
    ? found.find((t) => t.name.toLowerCase() === key || t.slug === slugify(name))
    : null;
  if (match) {
    cache.set(key, match.id);
    return match.id;
  }

  // Create
  if (DRY_RUN) {
    log(`[dry-run] would create ${type}: ${name}`);
    cache.set(key, -1);
    return -1;
  }
  try {
    const created = await wpFetch(endpoint, {
      method: "POST",
      body: { name },
    });
    cache.set(key, created.id);
    return created.id;
  } catch (err) {
    // Race / already-exists — refetch
    const msg = String(err.message || "");
    if (msg.includes("term_exists") || msg.includes("400")) {
      const again = await wpFetch(
        `${endpoint}?search=${encodeURIComponent(name)}&per_page=100`
      );
      const m2 = Array.isArray(again)
        ? again.find((t) => t.name.toLowerCase() === key)
        : null;
      if (m2) {
        cache.set(key, m2.id);
        return m2.id;
      }
    }
    throw err;
  }
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 190);
}

// ============ Media helpers ============
async function findMediaBySlug(slug) {
  const res = await wpFetch(`/media?slug=${encodeURIComponent(slug)}&per_page=1`);
  return Array.isArray(res) && res.length > 0 ? res[0] : null;
}

async function uploadMedia(filename, buffer) {
  const existing = await findMediaBySlug(slugify(filename.replace(/\.[^.]+$/, "")));
  if (existing) return existing.id;

  if (DRY_RUN) {
    log(`[dry-run] would upload media: ${filename} (${buffer.length} bytes)`);
    return null;
  }

  const blob = new Blob([buffer], { type: guessMime(filename) });
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await wpFetch("/media", { method: "POST", body: form });
  return res?.id || null;
}

async function resolveFeaturedImage(fm, mdBody) {
  // Priority 1: Notion cover URL (signed URL, fresh from same CI run)
  if (fm.cover && typeof fm.cover === "string" && /^https?:\/\//.test(fm.cover)) {
    try {
      const buf = await fetchBuffer(fm.cover);
      // Stable filename derived from page id for dedup
      const suffix = fm.source_page_id
        ? String(fm.source_page_id).replace(/-/g, "").slice(0, 8)
        : crypto.createHash("sha1").update(fm.cover).digest("hex").slice(0, 8);
      // Try to infer extension from URL path
      let ext = "jpg";
      const mExt = fm.cover.match(/\.(png|jpe?g|gif|webp|bmp)(?:\?|$)/i);
      if (mExt) ext = mExt[1].toLowerCase();
      const filename = `cover-${suffix}.${ext}`;
      const id = await uploadMedia(filename, buf);
      if (id) return id;
    } catch (err) {
      warn(`cover fetch failed, falling back to inline: ${err.message}`);
    }
  }
  // Priority 2: first inline asset (always stable, local file on runner)
  const rel = firstInlineAsset(mdBody);
  if (rel) {
    const localPath = path.join(ASSETS_DIR, rel);
    if (fs.existsSync(localPath)) {
      try {
        const buf = fs.readFileSync(localPath);
        const id = await uploadMedia(rel, buf);
        if (id) return id;
      } catch (err) {
        warn(`featured upload failed: ${err.message}`);
      }
    }
  }
  return null;
}

// ============ Post CRUD ============
async function findPostBySlug(slug) {
  // Query by slug + include drafts/any status
  const res = await wpFetch(
    `/posts?slug=${encodeURIComponent(slug)}&status=publish,draft,pending,private,future&per_page=1`
  );
  return Array.isArray(res) && res.length > 0 ? res[0] : null;
}

async function upsertPost(slug, payload) {
  const existing = await findPostBySlug(slug);
  if (existing) {
    if (DRY_RUN) {
      log(`[dry-run] would UPDATE post #${existing.id}: ${payload.title}`);
      return existing;
    }
    return await wpFetch(`/posts/${existing.id}`, {
      method: "POST",
      body: payload,
    });
  } else {
    if (DRY_RUN) {
      log(`[dry-run] would CREATE post: ${payload.title}`);
      return { id: -1, slug };
    }
    return await wpFetch("/posts", {
      method: "POST",
      body: { ...payload, slug },
    });
  }
}

// ============ Main ============
async function main() {
  log(`Target WP site: ${WP_URL}`);
  log(`User: ${WP_USER}`);
  log(`Raw asset base: ${RAW_BASE || "(GITHUB_REPOSITORY not set — skipping URL rewrite)"}`);

  const files = listMarkdownFiles(ARTICLE_DIR);
  log(`Found ${files.length} markdown files`);
  if (files.length === 0) {
    log("Nothing to publish.");
    return;
  }

  // Ensure sync marker tag exists so we can track and later clean up orphans
  const syncedTagId = await ensureTerm("post_tag", SYNCED_TAG);

  const pushedSlugs = new Set();
  let ok = 0,
    fail = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const title = fm.title || path.basename(file, ".md");
    const slug = slugify(path.basename(file, ".md"));

    try {
      log(`→ ${path.relative(ARTICLE_DIR, file)}  (slug: ${slug})`);

      // Rewrite inline asset paths so images render on WP
      const rewritten = rewriteAssetUrls(body);
      const html = marked.parse(rewritten, { mangle: false, headerIds: true });

      // Category — single primary category based on fm.category
      const categoryIds = [];
      if (fm.category) {
        const cid = await ensureTerm("category", fm.category);
        if (cid && cid > 0) categoryIds.push(cid);
      }

      // Tags — fm.tags is array if present; also always append SYNCED_TAG
      const tagIds = [];
      const tags = Array.isArray(fm.tags) ? fm.tags : [];
      for (const t of tags) {
        if (!t) continue;
        const tid = await ensureTerm("post_tag", t);
        if (tid && tid > 0) tagIds.push(tid);
      }
      if (syncedTagId && syncedTagId > 0) tagIds.push(syncedTagId);

      // Featured image
      const featuredId = await resolveFeaturedImage(fm, body);

      const payload = {
        title,
        content: html,
        excerpt: "",
        status: POST_STATUS,
        categories: categoryIds,
        tags: tagIds,
      };
      if (featuredId) payload.featured_media = featuredId;
      if (fm.date) {
        // WP accepts ISO 8601; treat fm.date as the publish date if provided
        payload.date = new Date(fm.date).toISOString();
      }

      const post = await upsertPost(slug, payload);
      pushedSlugs.add(slug);
      log(`  ✓ ${post.id ? `#${post.id}` : "(created)"}  ${title}`);
      ok++;
    } catch (err) {
      fail++;
      warn(`  ✗ ${file}: ${err.message}`);
    }
  }

  // ============ Prune orphans ============
  // Any post that carries the SYNCED_TAG but whose slug wasn't in this run →
  // trash (soft delete). Never touches manually-authored posts.
  if (syncedTagId && syncedTagId > 0 && !DRY_RUN) {
    log("Scanning for orphan synced posts to trash...");
    let page = 1;
    let trashed = 0;
    while (true) {
      const list = await wpFetch(
        `/posts?tags=${syncedTagId}&per_page=100&page=${page}&status=publish,draft,pending,private,future&_fields=id,slug`
      );
      if (!Array.isArray(list) || list.length === 0) break;
      for (const p of list) {
        if (!pushedSlugs.has(p.slug)) {
          try {
            await wpFetch(`/posts/${p.id}`, { method: "DELETE" }); // default: move to trash
            log(`  🗑  trashed orphan #${p.id}  (${p.slug})`);
            trashed++;
          } catch (err) {
            warn(`  trash ${p.id} failed: ${err.message}`);
          }
        }
      }
      if (list.length < 100) break;
      page++;
    }
    log(`Orphan cleanup: trashed ${trashed}`);
  }

  log(`Done. ok=${ok} fail=${fail} of ${files.length}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[publish-wp] FATAL:", err);
  process.exit(1);
});

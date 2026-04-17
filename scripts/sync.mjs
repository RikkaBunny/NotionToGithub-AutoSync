import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import http from "http";

// ============ Config ============
const NOTION_SECRET = process.env.NOTION_SECRET;
const NOTION_DATABASE_RAW = process.env.NOTION_DATABASE;
// Multi-status support — comma-separated, e.g. "Done,Published"
const FILTER_STATUSES = (process.env.FILTER_STATUS || "Done")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ARTICLE_DIR = process.env.ARTICLE_DIR || "articles";
const ASSETS_DIR = process.env.ASSETS_DIR || "assets";
const INCREMENTAL = process.env.INCREMENTAL !== "false"; // on by default
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const PRUNE_ASSETS = process.env.PRUNE_ASSETS !== "false";

// Category alias map — normalize similar categories to a canonical name.
// Keys are lowercased for matching; values are the canonical display name.
const CATEGORY_ALIASES = {
  // Unreal family
  "ue": "Unreal",
  "ue4": "Unreal",
  "ue5": "Unreal",
  "unreal": "Unreal",
  "unreal engine": "Unreal",
  "虚幻": "Unreal",
  "虚幻引擎": "Unreal",
  // Unity family
  "unity": "Unity",
  "unity3d": "Unity",
  // Houdini family
  "houdini": "Houdini",
  "sidefx": "Houdini",
  // Shader/rendering family
  "shader": "Shader",
  "shaders": "Shader",
  "rendering": "Shader",
  "渲染": "Shader",
  "图形学": "Shader",
  // Fluid/water family
  "water": "Fluid",
  "fluid": "Fluid",
  "流体": "Fluid",
  // Math family
  "math": "Math",
  "数学": "Math",
  "algorithm": "Math",
  "算法": "Math",
  // Linux/server
  "linux": "Linux",
  "server": "Linux",
  "服务器": "Linux",
  // General knowledge
  "通识": "通识",
  "general": "通识",
  "misc": "通识",
};

function normalizeCategory(raw) {
  if (!raw) return "Uncategorized";
  const key = String(raw).trim().toLowerCase();
  return CATEGORY_ALIASES[key] || String(raw).trim();
}

if (!NOTION_SECRET || !NOTION_DATABASE_RAW) {
  console.error("Missing NOTION_SECRET or NOTION_DATABASE env vars");
  process.exit(1);
}

// ============ ID normalization (single source of truth) ============
function normalizeId(raw) {
  if (!raw) return null;
  const str = String(raw);
  const dashed = str.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
  );
  if (dashed) return dashed[1].replace(/-/g, "");
  const plain = str.match(/([a-f0-9]{32})/i);
  if (plain) return plain[1];
  return null;
}

const NOTION_DATABASE = normalizeId(NOTION_DATABASE_RAW);
if (!NOTION_DATABASE) {
  console.error(
    `Could not extract 32-hex database id from: ${NOTION_DATABASE_RAW}`
  );
  process.exit(1);
}
console.log(
  `DB raw length=${NOTION_DATABASE_RAW.length}, normalized length=${NOTION_DATABASE.length}`
);

const notion = new Client({ auth: NOTION_SECRET });
const n2m = new NotionToMarkdown({ notionClient: notion });

// ============ Retry helper ============
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.code;
      const retryable =
        status === 429 ||
        (typeof status === "number" && status >= 500 && status < 600) ||
        status === "ETIMEDOUT" ||
        status === "ECONNRESET" ||
        status === "ECONNREFUSED" ||
        status === undefined;
      if (!retryable || attempt === MAX_RETRIES) break;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ↻ retry ${attempt}/${MAX_RETRIES - 1} ${label} after ${delay}ms (${err.message})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ============ Helpers ============
function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // follow redirect
        res.resume();
        resolve(fetchBuffer(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms for ${url}`)
      );
    });
  });
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase();
    if (ext && ext.length <= 6) return ext;
  } catch {
    /* ignore */
  }
  return ".png";
}

function loadAssetIndex() {
  const index = new Map();
  if (!fs.existsSync(ASSETS_DIR)) return index;
  for (const f of fs.readdirSync(ASSETS_DIR)) {
    const full = path.join(ASSETS_DIR, f);
    try {
      const buf = fs.readFileSync(full);
      index.set(sha1(buf), f);
    } catch {
      /* ignore */
    }
  }
  return index;
}

// Keep Chinese / Japanese / etc. — only strip filesystem-unsafe chars
function sanitizeName(name) {
  if (!name) return "untitled";
  return (
    String(name)
      .replace(/[\/\\:*?"<>|\r\n\t]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "untitled"
  );
}

// Prefer slug; else Chinese/English title + 6-char page id suffix for uniqueness
function buildFilename(slug, title, pageId) {
  if (slug && String(slug).trim()) return sanitizeName(slug).replace(/\s+/g, "-");
  const base = sanitizeName(title);
  const suffix = pageId ? String(pageId).replace(/-/g, "").slice(0, 6) : "";
  return suffix ? `${base}-${suffix}` : base;
}

function getPropValue(props, ...keys) {
  for (const k of keys) {
    const p = props[k];
    if (!p) continue;
    if (p.type === "title") return p.title.map((t) => t.plain_text).join("");
    if (p.type === "rich_text")
      return p.rich_text.map((t) => t.plain_text).join("");
    if (p.type === "url") return p.url;
    if (p.type === "multi_select") return p.multi_select.map((t) => t.name);
    if (p.type === "select") return p.select ? p.select.name : null;
    if (p.type === "date") return p.date ? p.date.start : null;
    if (p.type === "status") return p.status ? p.status.name : null;
    if (p.type === "files") {
      const f = p.files && p.files[0];
      return f ? (f.external?.url || f.file?.url || null) : null;
    }
  }
  return null;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const out = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    let val = m[2];
    try {
      val = JSON.parse(val);
    } catch {
      /* keep raw */
    }
    out[m[1]] = val;
  }
  return out;
}

// ============ Main ============
async function main() {
  if (!fs.existsSync(ARTICLE_DIR))
    fs.mkdirSync(ARTICLE_DIR, { recursive: true });
  if (!fs.existsSync(ASSETS_DIR))
    fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const assetIndex = loadAssetIndex();
  console.log(`Loaded ${assetIndex.size} cached assets`);

  const statusFilter =
    FILTER_STATUSES.length === 1
      ? { property: "Status", status: { equals: FILTER_STATUSES[0] } }
      : {
          or: FILTER_STATUSES.map((s) => ({
            property: "Status",
            status: { equals: s },
          })),
        };

  const pages = [];
  let cursor;
  do {
    const queryArgs = { database_id: NOTION_DATABASE, filter: statusFilter };
    if (cursor) queryArgs.start_cursor = cursor;
    const resp = await withRetry(
      () => notion.databases.query(queryArgs),
      "databases.query"
    );
    pages.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  console.log(
    `Found ${pages.length} page(s) with Status in [${FILTER_STATUSES.join(", ")}]`
  );

  // Track every file we touch this run; prune the rest at the end
  const generatedFiles = new Set(); // absolute-ish paths
  const referencedAssets = new Set();

  async function downloadImage(url) {
    const buf = await withRetry(
      () => fetchBuffer(url),
      `download ${url.slice(0, 80)}`
    );
    const hash = sha1(buf);
    if (assetIndex.has(hash)) {
      const existing = assetIndex.get(hash);
      referencedAssets.add(path.join(ASSETS_DIR, existing));
      // markdown file lives in articles/<Category>/<file>.md  → need ../../assets/...
      return path.posix.join("..", "..", ASSETS_DIR, existing);
    }
    const ext = extFromUrl(url);
    const filename = `${hash}${ext}`;
    const dest = path.join(ASSETS_DIR, filename);
    fs.writeFileSync(dest, buf);
    assetIndex.set(hash, filename);
    referencedAssets.add(dest);
    console.log(`  ↓ asset ${filename}`);
    return path.posix.join("..", "..", ASSETS_DIR, filename);
  }

  for (const entry of pages) {
    const props = entry.properties;
    const name = getPropValue(props, "Name", "Title") || "untitled";
    const notionUrlField = getPropValue(props, "Notion URL", "URL");
    const rawTags = getPropValue(props, "Tags");
    const tags = Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [];
    const dateVal = getPropValue(
      props,
      "Published Date",
      "Publish Date",
      "Date"
    );
    const slug = getPropValue(props, "Slug");
    const coverFromProp = getPropValue(props, "Cover");
    const cover =
      coverFromProp ||
      entry.cover?.external?.url ||
      entry.cover?.file?.url ||
      null;
    const rawCategory = getPropValue(props, "Category");
    const category = normalizeCategory(rawCategory);
    const createdAt = entry.created_time;
    const updatedAt = entry.last_edited_time;
    const sourcePageId =
      normalizeId(notionUrlField) || entry.id.replace(/-/g, "");

    const categoryDir = path.join(ARTICLE_DIR, sanitizeName(category));
    if (!fs.existsSync(categoryDir))
      fs.mkdirSync(categoryDir, { recursive: true });
    const filename = buildFilename(slug, name, sourcePageId);
    const outPath = path.join(categoryDir, `${filename}.md`);

    // Incremental sync — compare updatedAt in existing frontmatter
    if (INCREMENTAL && fs.existsSync(outPath)) {
      const fm = parseFrontmatter(fs.readFileSync(outPath, "utf8"));
      if (fm.updatedAt && fm.updatedAt === updatedAt) {
        generatedFiles.add(outPath);
        // still mark referenced assets by scanning the md
        const existingText = fs.readFileSync(outPath, "utf8");
        for (const m of existingText.matchAll(
          /!\[[^\]]*\]\(\.\.\/\.\.\/([^)]+)\)/g
        )) {
          referencedAssets.add(m[1]);
        }
        console.log(`  = skip (unchanged) ${outPath}`);
        continue;
      }
    }

    console.log(
      `\nProcessing: ${name}  [${category}]  (src=${sourcePageId.slice(0, 8)}…)`
    );

    let md;
    try {
      const mdblocks = await withRetry(
        () => n2m.pageToMarkdown(sourcePageId),
        `pageToMarkdown ${sourcePageId}`
      );
      md = n2m.toMarkdownString(mdblocks).parent || "";
    } catch (err) {
      console.error(
        `  ✗ failed to fetch page ${sourcePageId}: ${err.message}`
      );
      continue;
    }

    // Rewrite markdown images
    const mdImgRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    const mdMatches = [...md.matchAll(mdImgRegex)];
    for (const m of mdMatches) {
      const url = m[2];
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const localPath = await downloadImage(url);
        md = md.replace(m[0], `![${m[1]}](${localPath})`);
      } catch (err) {
        console.warn(`  ! download failed: ${url} — ${err.message}`);
      }
    }

    // Rewrite HTML <img src="…">
    const htmlImgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
    const htmlMatches = [...md.matchAll(htmlImgRegex)];
    for (const m of htmlMatches) {
      const url = m[1];
      if (!/^https:?/\//i.test(url)) continue;
      try {
        const localPath = await downloadImage(url);
        md = md.replace(m[0], m[0].replace(url, localPath));
      } catch (err) {
        console.warn(`  ! download failed: ${url} — ${err.message}`);
      }
    }

    // Frontmatter aligned with README
    const frontmatterLines = [
      "---",
      `title: ${JSON.stringify(name)}`,
      slug ? `slug: ${JSON.stringify(slug)}` : null,
      `category: ${JSON.stringify(category)}`,
      tags.length ? `tags: ${JSON.stringify(tags)}` : null,
      cover ? `cover: ${JSON.stringify(cover)}` : null,
      dateVal ? `date: ${JSON.stringify(dateVal)}` : null,
      `createdAt: ${JSON.stringify(createdAt)}`,
      `updatedAt: ${JSON.stringify(updatedAt)}`,
      notionUrlField ? `notion_url: ${JSON.stringify(notionUrlField)}` : null,
      `source_page_id: ${JSON.stringify(sourcePageId)}`,
      "---",
      "",
    ].filter(Boolean);

    fs.writeFileSync(outPath, frontmatterLines.join("\n") + "\n" + md, "utf8");
    generatedFiles.add(outPath);
    console.log(`  ✓ wrote ${outPath}`);
  }

  pruneArticles(generatedFiles);
  if (PRUNE_ASSETS) pruneAssets(referencedAssets);
  generateIndex();

  console.log("\nDone.");
}

// ============ Prune orphan files ============
function pruneArticles(keep) {
  if (!fs.existsSync(ARTICLE_DIR)) return;
  const indexFiles = new Set(["README.md", "TAGS.md"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      if (dir === ARTICLE_DIR && indexFiles.has(entry.name)) continue;
      if (!keep.has(full)) {
        fs.unlinkSync(full);
        console.log(`  × pruned ${full}`);
      }
    }
  };
  walk(ARTICLE_DIR);

  // Remove empty category dirs
  for (const d of fs.readdirSync(ARTICLE_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const full = path.join(ARTICLE_DIR, d.name);
    if (fs.readdirSync(full).length === 0) {
      fs.rmdirSync(full);
      console.log(`  × pruned empty dir ${full}`);
    }
  }
}

function pruneAssets(keep) {
  if (keep.size === 0) return; // safety: don't nuke everything if nothing was generated
  if (!fs.existsSync(ASSETS_DIR)) return;
  for (const f of fs.readdirSync(ASSETS_DIR)) {
    const full = path.join(ASSETS_DIR, f);
    if (!keep.has(full)) {
      fs.unlinkSync(full);
      console.log(`  × pruned asset ${full}`);
    }
  }
}

// ============ Index generation ============
function generateIndex() {
  if (!fs.existsSync(ARTICLE_DIR)) return;
  const categories = {};
  for (const cat of fs.readdirSync(ARTICLE_DIR, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    const catDir = path.join(ARTICLE_DIR, cat.name);
    const files = fs.readdirSync(catDir).filter((f) => f.endsWith(".md"));
    const items = [];
    for (const f of files) {
      const full = path.join(catDir, f);
      const text = fs.readFileSync(full, "utf8");
      const fm = parseFrontmatter(text);
      items.push({
        file: path.posix.join(cat.name, f),
        title: fm.title || f.replace(/\.md$/, ""),
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        updatedAt: fm.updatedAt || "",
      });
    }
    items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    categories[cat.name] = items;
  }

  const total = Object.values(categories).reduce((s, a) => s + a.length, 0);
  const stamp = new Date().toISOString();
  const lines = [
    "# 文章目录",
    "",
    `> 自动生成于 \`${stamp}\` · 共 **${total}** 篇 · 按分类 → 更新时间倒序`,
    "",
    "> 按标签浏览 → [TAGS.md](TAGS.md)",
    "",
  ];
  for (const cat of Object.keys(categories).sort()) {
    const items = categories[cat];
    if (items.length === 0) continue;
    lines.push(`## ${cat} (${items.length})`);
    lines.push("");
    for (const it of items) {
      const tagStr =
        it.tags && it.tags.length
          ? ` · ${it.tags.map((t) => `\`${t}\``).join(" ")}`
          : "";
      const dateStr = it.updatedAt ? ` · ${it.updatedAt.slice(0, 10)}` : "";
      lines.push(`- [${it.title}](${it.file})${tagStr}${dateStr}`);
    }
    lines.push("");
  }
  fs.writeFileSync(
    path.join(ARTICLE_DIR, "README.md"),
    lines.join("\n"),
    "utf8"
  );
  console.log(`  ✓ wrote ${path.join(ARTICLE_DIR, "README.md")}`);

  // TAGS.md — cross-cutting index
  const tagIndex = {};
  for (const cat of Object.keys(categories)) {
    for (const it of categories[cat]) {
      for (const t of it.tags || []) {
        (tagIndex[t] ||= []).push({ ...it, category: cat });
      }
    }
  }
  if (Object.keys(tagIndex).length > 0) {
    const tagLines = [
      "# 标签索引",
      "",
      `> 自动生成 · ${Object.keys(tagIndex).length} 个标签`,
      "",
    ];
    for (const tag of Object.keys(tagIndex).sort()) {
      const items = tagIndex[tag].sort((a, b) =>
        (b.updatedAt || "").localeCompare(a.updatedAt || "")
      );
      tagLines.push(`## ${tag} (${items.length})`);
      tagLines.push("");
      for (const it of items) {
        tagLines.push(`- [${it.title}](${it.file}) · *${it.category}*`);
      }
      tagLines.push("");
    }
    fs.writeFileSync(
      path.join(ARTICLE_DIR, "TAGS.md"),
      tagLines.join("\n"),
      "utf8"
    );
    console.log(`  ✓ wrote ${path.join(ARTICLE_DIR, "TAGS.md")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

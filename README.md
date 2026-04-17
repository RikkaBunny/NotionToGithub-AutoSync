# NotionToGithub-AutoSync

[![Notion Sync](https://github.com/RikkaBunny/NotionToGithub-AutoSync/actions/workflows/notion-sync.yml/badge.svg)](https://github.com/RikkaBunny/NotionToGithub-AutoSync/actions/workflows/notion-sync.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

把 Notion 数据库里的文章**每天自动同步**到 GitHub，按分类落盘、生成索引、厷重资源、增量更新，完全不用维护服务器。

---

## 它做了什么

Notion 写文章 → GitHub Actions 每天跑一次 → 仓库里得到一棵干净的文章树：

```
articles/
├── README.md          # 文章目录（按分类分组，按更新时间倒序）
├── TAGS.md            # 标签索引（仅当有标签时生成）
├── Unreal/
│   ├── Flux流体运算.md
│   └── ...
├── Unity/
├── GPU/
├── Houdini/
└── ...
assets/
└── <sha1>.<ext>       # 图片按内容 hash 去重
```

每篇文章是独立 Markdown，顶部带 frontmatter（title / category / tags / date / notion_url 等），直接可喂给 Hexo、Hugo、Astro 这类静态站点生成器。

---

## 工作流程

```
┌──────────┐   1. cron / 手动触发   ┌───────────────┐
│  Notion  │ ◄──────────────────── │ GitHub Actions│
│ Database │   2. query pages      └───────┬───────┘
└────┬─────┘ ◄──────────────────────────── │
     │      3. blocks → markdown           │
     │      4. 下载图片并去重              │
     └────► 5. 写 articles/<Category>/*.md │
            6. 生成 README.md / TAGS.md    │
            7. 清理孤儿文件和资源          │
            8. git commit & push ──────────┘
```

每一步的实现都在 [`scripts/sync.mjs`](scripts/sync.mjs) 里，workflow 的编排在 [`.github/workflows/notion-sync.yml`](.github/workflows/notion-sync.yml)。

---

## 快速开始

### 1. Fork 这个仓库

或者直接 use this template，然后 clone 下来。

### 2. 准备 Notion 一侧

创建一个 Notion integration（[官方教程](https://developers.notion.com/docs/create-a-notion-integration)），拿到 `NOTION_SECRET`；把它连接到你要同步的 database，并复制 database ID。

数据库至少要有这几个字段（名字大小写严格匹配）：

| Notion 属性        | 类型      | 必填 | 说明                                                          |
| ----------------- | --------- | ---- | ------------------------------------------------------------- |
| `Name`            | Title     | ✅   | 文章标题                                                      |
| `Status`          | Status    | ✅   | 只同步指定状态（默认 `Done`）                                 |
| `Category`        | Select    | 推荐 | 分类目录名；支持别名（`ue` / `ue5` → `Unreal`）                |
| `Tags`            | Multi-select | ⛔  | 可选，存在时生成 `TAGS.md`                                    |
| `Slug`            | Rich text | ⛔   | 可选，自定义文件名                                            |
| `Published Date`  | Date      | ⛔   | 可选，用于 frontmatter 的 `date`                              |
| `Cover`           | Files/URL | ⛔   | 可选，覆盖 Notion 页封面                                      |
| `Notion URL`      | URL       | ⛔   | 可选，留外链兜底                                              |

### 3. 配置 GitHub Secrets

在仓库的 **Settings → Secrets and variables → Actions** 里加两个 secret：

- `NOTION_SECRET` — 上一步拿到的 integration token
- `NOTION_DATABASE` — database ID—带不带连字符都行，脚本会归一化）

### 4. 触发同步

- **自动**：每天 02:00 UTC 跑一次（cron）
- **手动**：`Actions → Notion Sync → Run workflow`，可选调 `filter_status`（多个逗号分隔，如 `Done,Published`）和 `incremental`

同步完成后 `articles/` 和 `assets/` 就会被 bot 自动 commit 到 `main`。

---

## 特性

| 特性             | 做法                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| **分类分目录**   | 读 `Category` 属性，`ue/ue4/ue5/虚幻` 等别名统一归到 `Unreal`              |
| **增量同步**     | 对比 frontmatter 里的 `updatedAt` 和 Notion 的 `last_edited_time`，跳过未变的 |
| **图片去重**     | 按内容 SHA1 命名，同一张图只存一份；被引用的相对路径自动回写               |
| **孤儿清理**     | 每次运行后，Notion 里被删除 / 改状态的文章，对应的 `.md` 和资源也会被删掉  |
| **稳定文件名**   | `slug` > 标题 sanitize > 加 page-id 短 hash，防止重名/改名导致历史断链     |
| **多状态过滤**   | `filter_status` 支持传 `Done,Published` 这种组合                            |
| **失败告警**     | workflow 失败时自动开/更新 GitHub Issue，打上 `sync-failed` 标签           |
| **并发保护**     | `concurrency: notion-sync` 防止手动触发和定时任务撞车                      |

---

## 本地跑一次（调试用）

```bash
npm install
export NOTION_SECRET=secret_xxx
export NOTION_DATABASE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export FILTER_STATUS=Done        # 可选
export INCREMENTAL=true          # 可选
npm run sync
```

然后去看 `articles/` 和 `assets/`。

> 注意 lockfile：项目依赖 `@notionhq/client` → `node-fetch@2` → `whatwg-url@5.0.0`。一旦你修改依赖，记得 `rm -rf node_modules package-lock.json && npm install` 整体重新生成 lock，避免 CI 出现 `EINTEGRITY`。

---

## 可调的环境变量

| 变量                  | 默认值      | 说明                                      |
| --------------------- | ----------- | ----------------------------------------- |
| `NOTION_SECRET`       | —           | **必填**，integration token               |
| `NOTION_DATABASE`     | —           | **必填**，database ID                     |
| `FILTER_STATUS`       | `Done`      | 要同步的 Status 值，逗号分隔              |
| `ARTICLE_DIR`         | `articles`  | 文章输出根目录                            |
| `ASSETS_DIR`          | `assets`    | 图片输出目录                              |
| `INCREMENTAL`         | `true`      | 是否跳过 `updatedAt` 未变的页面           |
| `FETCH_TIMEOUT_MS`    | `30000`     | 下载图片的单次超时                        |
| `MAX_RETRIES`         | `3`         | 下载 / 查询失败时的重试次数               |
| `PRUNE_ASSETS`        | `true`      | 是否清理未被任何文章引用的资源            |

---

## 目录结构

```
.
├── .github/workflows/
│   └── notion-sync.yml      # GitHub Actions 调度 + 兜底 issue
├── scripts/
│   └── sync.mjs             # 单文件核心同步脚本
├── articles/                # 生成物：按分类的 Markdown 文章
├── assets/                  # 生成物：去重后的图片
├── package.json
├── package-lock.json
├── .env.example             # 本地环境变量样例
├── .npmrc                   # npm 源 + 重试策略
├── CONTRIBUTING.md
├── LICENSE
└── README.md                # ← 就是你现在看的这个
```

---

## 贡献

欢迎 issue / PR。改代码前建议先跑一遍本地同步，确认输出符合预期。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE) © RikkaBunny

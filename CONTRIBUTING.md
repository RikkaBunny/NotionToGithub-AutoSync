# Contributing to NotionToGithub-AutoSync

Thanks for your interest! This project aims to stay small, reliable, and easy to self-host. Any kind of help — bug reports, docs, translations, or code — is welcome.

## Ways to Contribute

- **Report bugs** via [GitHub Issues](../../issues). Please include the failing run URL (if any), Node version, and the relevant part of `sync.mjs` or workflow log.
- **Request features** by opening an issue first so we can discuss scope.
- **Improve documentation** — typos, clearer instructions, translations.
- **Submit pull requests** for code improvements (see below).

## Development Setup

```bash
git clone https://github.com/RikkaBunny/NotionToGithub-AutoSync.git
cd NotionToGithub-AutoSync
npm install

# Copy the template and fill in your own values
cp .env.example .env

# Then load it (or just export the vars directly)
export $(grep -v '^#' .env | xargs)

node scripts/sync.mjs
```

Requires **Node.js 22+**.

## Coding Guidelines

- Keep `scripts/sync.mjs` as a single ESM file with no unnecessary dependencies — one of the points of this project is that you can read and audit the whole sync in one sitting.
- Prefer small, focused PRs. Include a short description of *why*, not just *what*.
- Don't introduce non-trivial runtime deps without discussion.
- Add comments for any non-obvious behavior (Notion API quirks, filename collisions, incremental-sync edge cases, etc.).
- If you change the frontmatter schema or output layout, call it out in the PR — downstream static-site users rely on it.

## Running the Workflow Locally

You can simulate a dry run locally without actually committing:

```bash
NOTION_SECRET=xxx NOTION_DATABASE=xxx FILTER_STATUS=Done INCREMENTAL=false npm run sync
```

Then inspect `articles/` and `assets/`. When you're done, `git stash` or reset.

## Code of Conduct

Be kind. Assume good faith. English or 中文 are both fine in issues and PRs.

## License

By contributing you agree your changes are released under the [MIT License](LICENSE).

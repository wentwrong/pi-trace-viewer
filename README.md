# Pi Trace Viewer

A small, fast, local-first viewer for [Pi Agent Harness](https://pi.dev) session traces.

Pi stores sessions as JSONL files (under `~/.pi/agent/sessions/`). This viewer turns those files into an easy-to-navigate timeline for inspecting prompts, model responses, reasoning, tool calls, branches, usage, and errors.

The whole app is a single static HTML page: open the hosted copy on GitHub Pages, or download `index.html` from it and open it straight from disk — it works offline either way.

## Features

- Upload or drag-and-drop `.jsonl` or `.json` session traces directly in the browser
- Built-in example trace for trying the viewer without a file
- Virtualized event list for large traces
- Full-text search across all values in the trace (keys, image data, and signatures are ignored)
- Filters for messages, tool results, settings, compaction, and other entries
- Failed tool results, assistant errors, and non-zero bash exits are highlighted
- Detail view for message content, thinking, tool arguments, images, system prompt sections, usage, and raw JSON
- Links for parents, label targets, compaction/branch references, and tool call ↔ result pairs
- Keyboard: `/` search, `Esc` leave search, `j`/`k` move, `Enter` scroll to selection
- Responsive layout for desktop and mobile screens
- No server-side processing or data uploads
- Production build is one self-contained HTML page

## Development

Requires Node.js 20.19+ or 22.12+. Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Then open the local URL printed by Vite and upload a Pi session file.

## Production build

Create the standalone viewer:

```bash
npm run build
```

The result is written to:

```text
dist/index.html
```

It contains the JavaScript and CSS inline, so it can be served as a single static page.

## Testing

Run the build, the parser check, and the standalone-output check:

```bash
npm test
```

This builds `dist/index.html` and checks that it is a single self-contained page, that its Content Security Policy hash matches the inlined script, and that the parser tolerates malformed input.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs `npm ci && npm test` on every push to `main` and publishes `dist/index.html` to GitHub Pages.

One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. The site is then served at `https://<user>.github.io/<repo>/`.

Because the build has no external assets, it works under any base path and can equally be hosted on any static file server.

## Pi session format

The viewer accepts Pi JSONL session files, including the current v3 format. It understands common entries such as:

- `message`
- `model_change`
- `thinking_level_change`
- `usage`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `context_edit`
- `label`
- `session_info`

Message roles `system`, `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `branchSummary`, and `compactionSummary` are rendered; unknown roles fall back to their content and raw JSON.

Unknown entry types are preserved and displayed as raw JSON rather than rejected. Invalid lines (for example a truncated last line of a live session) are skipped with a warning instead of failing the whole file.

## Privacy

Trace files are read locally with the browser `FileReader` API. The application does not send trace contents to a backend or third-party service, and the production build enforces this with a Content Security Policy that blocks all network requests.

Remember that Pi traces may contain prompts, source code, command output, credentials accidentally printed by tools, and other sensitive information. Review traces before sharing them.

## Project structure

```text
src/App.svelte          Main viewer UI and trace handling
src/parse.mjs           Tolerant JSONL/JSON trace parser
src/main.js             Application entry point
index.html              Vite document shell
vite.config.mjs         Vite/Svelte build configuration
scripts/inline-dist.mjs Produces the single-file production build (inlines JS/CSS, adds the CSP)
scripts/check-dist.mjs  Parser self-check and standalone-output verification
.github/workflows/      GitHub Pages build and deploy
```

## License

Not specified yet. Until a license is added, all rights are reserved by the author.

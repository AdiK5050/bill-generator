# Bill Generator

A template-based bill and invoice generator for small businesses. Pick a built-in template or upload your own `.html` template, fill in the auto-generated form, watch the live preview, then print or save as PDF. It runs offline on laptop, Android and iOS as an installable web app (PWA).

Use it as a **guest** (data stays on the device) or **sign in to your own sync server** to back up and sync between devices on a schedule you choose.

To make your own templates, open the template guide in the app (Templates > the template guide), or [docs/template-guide.html](docs/template-guide.html). It includes a live playground.

## Run locally

Requires Node.js 20.19 or newer (only for the dev server, tests and the optional sync server; the app itself has no build step).

```sh
npm install        # dev tools only: test runner, ESLint, Prettier
npm start          # serves the app at http://127.0.0.1:8080/
```

Any static file server works too. Open the app over `http://localhost` or HTTPS so the service worker (offline mode) can register.

To try it on a phone on the same Wi-Fi: `HOST=0.0.0.0 npm start`, then open `http://<laptop-ip>:8080/` on the phone. Offline mode and "install" need HTTPS, so use a real host (see Deploy) for that.

## Optional sync server

```sh
npm run server     # http://0.0.0.0:8787, data in server/data/
```

Then in the app: Settings > Account and server backup > Sign in to a server. See [server/README.md](server/README.md) for configuration, security notes and options for reaching a home server without a static IP or domain.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Local dev server for the app |
| `npm test` | Engine tests in headless Chrome (uses your installed Google Chrome; set `CHROME_PATH` for another Chromium) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run server` | Reference sync server |

## Deploy

Upload the repository (minus `server/`, `node_modules/`, `tests/`, `tools/`) to any static host with HTTPS, for example GitHub Pages, Netlify or Vercel. When you change any app file, bump `CACHE_VERSION` in `sw.js` so installed apps pick up the update.

## Project layout

```
index.html, css/, icons/, manifest.json, sw.js   app shell and PWA
js/engine/     reusable core: sanitizer, parser, renderer, calc, format (no UI code)
js/storage.js  IndexedDB storage, sync-ready records, backup import/export
js/sync/       guest/sign-in state, sync client and scheduler
js/ui/         views: bill editor, templates, history, settings
templates/     built-in templates
server/        optional self-hosted sync server (Node.js, no dependencies)
tests/         engine tests
```

## Security model (short version)

Templates are untrusted. Every template, from every source, is cleaned by DOMPurify plus a CSS filter that uses the browser's own CSS parser, then rendered in a sandboxed iframe with scripts disabled and a Content Security Policy that blocks all network access. Form values are always inserted as text, never as HTML.

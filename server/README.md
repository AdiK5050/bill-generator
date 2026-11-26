# Bill Generator sync server (optional)

A small self-hosted server that signed-in users of Bill Generator can back up and sync to. The app works fully without it (guest mode).

- Node.js 20 or newer, no dependencies, one file (`server.js`).
- Data is stored as JSON files on disk: `DATA_DIR/accounts.json` (users and session token hashes) and `DATA_DIR/users/<userId>.json` (each user's synced records).

## Run

```sh
node server/server.js
# or
cd server && npm start
```

Then, in the app, go to Settings > Account, enter the server URL (for example `http://localhost:8787`) and create an account. The first account can always be created; after that registration closes unless `ALLOW_REGISTRATION=1`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` for this machine only) |
| `DATA_DIR` | `./data` (next to `server.js`) | Where JSON data files are written |
| `ALLOWED_ORIGINS` | `*` | Comma-separated list of app origins allowed by CORS, e.g. `https://you.github.io,http://localhost:8080` |
| `ALLOW_REGISTRATION` | unset | Set to `1` to keep registration open after the first account exists |

Example:

```sh
PORT=8787 DATA_DIR=/srv/bill-sync ALLOWED_ORIGINS=https://you.github.io node server/server.js
```

## API

| Method and path | Body | Response |
|---|---|---|
| `GET /api/health` | | `{ ok, name, version, registrationOpen }` |
| `POST /api/register` | `{ username, password }` | `201 { token, user: { id, username } }` |
| `POST /api/login` | `{ username, password }` | `{ token, user: { id, username } }` |
| `POST /api/logout` | | `{ ok: true }` (revokes the token) |
| `GET /api/me` | | `{ user: { id, username } }` |
| `POST /api/sync` | `{ since, changes: [{ store, id, updatedAt, deleted, data }] }` | `{ rev, changes: [{ store, id, updatedAt, deleted, data }] }` |

- Authenticated calls send `Authorization: Bearer <token>`.
- Errors are `{ error: "message" }` with status 400, 401, 403 (registration closed), 404, 405, 409 (username taken), 413 (body over 50 MB) or 429 (too many failed logins).
- Usernames: 3 to 32 characters, letters, numbers, `_`, `.`, `-`, case-insensitive. Passwords: at least 8 characters.
- `store` is one of `templates`, `bills`, `kv`. A change is accepted when the server has no copy or `updatedAt` is greater than or equal to the stored one (last write wins). Each accepted change gets the next per-user revision number. The response lists every record with a revision above `since`, in revision order. Deleted records are kept as tombstones with `data: null`.

## Reaching the server from the app

**Mixed content.** Browsers block a page loaded over `https://` from calling an `http://` server. `localhost` / `127.0.0.1` are the exception. So:

- App served over HTTPS (GitHub Pages, Netlify, Vercel): the server must also be reachable over HTTPS.
- App served over plain HTTP on your own network (for example `python3 -m http.server` on a laptop): an `http://192.168.x.x:8787` server works, but installing the PWA and offline caching generally require HTTPS or `localhost`.

**No static IP or domain.** Some common options, to be evaluated when needed (check each one's current documentation, pricing and limits before relying on it):

- **Private mesh VPN (for example Tailscale):** your devices join a private network and reach the server by a stable device name, without opening ports on the router. Tailscale can issue HTTPS certificates for names like `machine.tailnet-name.ts.net` with no domain of your own (MagicDNS and HTTPS must be enabled; machine names appear in the public certificate log). Only devices in your tailnet can reach the server, which is a good fit for one shop's own phones and laptops.
- **Tunnel service (for example Cloudflare Tunnel):** the server opens an outbound connection to the provider, which exposes it at a public HTTPS address. Quick Tunnels need no account or domain, but the address changes every time the tunnel starts and there is no uptime guarantee, so it suits testing only (the app lets you change the server address). A stable named tunnel needs a domain on Cloudflare.
- **Dynamic DNS plus port forwarding:** a free dynamic DNS name follows your changing home IP, and the router forwards a port to the server. You then need your own HTTPS (for example a reverse proxy with a certificate). This does not work if your internet provider uses CGNAT.

## Security notes

- Passwords are hashed with scrypt and a random 16-byte salt per user. They are never logged or stored in plain text.
- Session tokens are 32 random bytes. Only their SHA-256 hashes are stored. Tokens expire after 90 days and can be revoked with logout.
- Failed logins are rate limited (10 per IP and username per 15 minutes, in memory, reset on restart).
- Request bodies are limited to 50 MB. Files are written atomically (temp file then rename) and writes are serialised per user.
- CORS defaults to `*`. This is acceptable because auth uses bearer tokens, not cookies, but you can restrict it with `ALLOWED_ORIGINS`.
- The server itself speaks plain HTTP. Put it behind HTTPS (tunnel, VPN, or reverse proxy) before exposing it beyond your own network.
- Data on disk is not encrypted. Protect the machine and `DATA_DIR` accordingly.

## Backup

Stop the server (or make sure no sync is running) and copy `DATA_DIR`. To restore, put the copy back and start the server.

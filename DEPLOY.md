# Deploying Hitscan

Two parts: the **client** (static files) and the **server** (a Node process that needs a long-lived
WebSocket). The client goes on Cloudflare Pages for free. The server cannot run on Pages or
Workers-style hosting, so it runs on any machine that can run Node, or a container.

Nothing here has been run on a real host yet. Treat the first deploy as a test.

## 1. Server

Settings (environment variables):

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | listening port | 8787 |
| `ALLOWED_ORIGINS` | comma-separated page addresses allowed to connect, e.g. `https://hitscan.pages.dev`. Empty = any | any |
| `MAX_MATCHES` | matches at once | 8 |
| `MAX_PER_IP` | connections per address | 6 |
| `TRUST_PROXY` | set to `1` when behind a tunnel or reverse proxy so the real client address is read from its headers | off |

`GET /health` answers `ok` for uptime checks.

### Option A: your own PC with a Cloudflare Tunnel (free, no open ports)

Good for demos. The game is up only while your PC and the tunnel are running.

1. Install `cloudflared`, then for a quick temporary address: `cloudflared tunnel --url http://localhost:8787`
   It prints an `https://something.trycloudflare.com` address. Your server address is the same with `wss://`.
2. Start the server (PowerShell): `$env:TRUST_PROXY="1"; $env:ALLOWED_ORIGINS="https://YOUR-SITE.pages.dev"; npm run server`
3. For a permanent address, create a named tunnel on a domain you own in the Cloudflare dashboard (Zero Trust, Networks, Tunnels) and point it at `http://localhost:8787`.

### Option B: a container host

`docker build -t hitscan-server .` then `docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://YOUR-SITE.pages.dev hitscan-server`.
Works on Fly.io, Render, Railway, or an always-free cloud VM (for example Oracle Cloud Always Free).
Put it behind HTTPS (these hosts do this for you) so the page can use `wss://`. Set `TRUST_PROXY=1` there too.
Free tiers that sleep when idle will add a wake-up delay to the first player.

## 2. Client on Cloudflare Pages

1. Push the repo to GitHub. In Cloudflare: Workers & Pages, Create, Pages, Connect to Git.
2. Build command: `npm install && npm run build`. Output directory: `client/dist`.
3. Environment variables: `NODE_VERSION=24` and `VITE_SERVER_URL=wss://YOUR-SERVER-ADDRESS`
   (the address is baked in at build time, so change it and redeploy if the server moves).
4. Open the Pages address. The lobby should say "Connected". Open it in a second window and join the same match.

You can also point any build at another server with `?server=wss://host` in the page address.

## Abuse limits (built in)

Messages per second are capped per connection (game and lobby separately), message size is capped
at 1 KB, nicknames are cleaned, connections per address are limited, idle lobby connections are
dropped, and a connection that keeps breaking the limits is closed.

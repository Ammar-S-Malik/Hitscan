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

### Option B: Render free plan (no card, sleeps when idle)

`render.yaml` in the repo describes the service.
1. Push the repo to GitHub. On render.com sign up with GitHub, then New, Blueprint, pick the `Hitscan` repo, apply.
2. When it asks for `ALLOWED_ORIGINS`, enter your Cloudflare Pages address (for example `https://hitscan.pages.dev`; you can edit it later under Environment).
3. Wait for the first deploy (a few minutes). Your server address is the service URL with `wss://`, for example `wss://hitscan-server.onrender.com`. `https://hitscan-server.onrender.com/health` should print `ok`.
4. In Cloudflare Pages set `VITE_SERVER_URL=wss://hitscan-server.onrender.com` and redeploy.

The free plan sleeps after 15 minutes with no traffic and takes about a minute to wake, and it has only 0.1 CPU and 512 MB, so keep
`MAX_MATCHES` low (8 is set). The page retries for about two minutes and shows "Waking the server up", so the first visitor waits instead of seeing an error.
To pre-wake it before showing someone, open the `/health` address first.

### Option C: any container host

`docker build -t hitscan-server .` then `docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://YOUR-SITE.pages.dev hitscan-server`.
Works on Railway, Koyeb, or any VM with Docker. Put it behind HTTPS so the page can use `wss://`, and set `TRUST_PROXY=1`.

### Option D: an always-on VM (about $4-6 a month, recommended for a permanent demo)

The server runs 24 hours a day on a small virtual machine with its own HTTPS address. Cloudflare's free plan cannot run the
game server itself (WebSocket messages count against a 100,000 requests/day limit, about 9 player-hours), and the free VM
offers are unreliable (Oracle's Always Free reclaims idle VMs and has cut allowances; Fly.io has no free tier for new
accounts). A small paid VM is the dependable way. Nothing in this section has been run on a real VM yet, so expect a snag or two.

**1. Make the VM.** Any provider works (Hetzner, DigitalOcean, Vultr, Linode). The cheapest plan with 1 vCPU and 1 GB is plenty:
the game server needs well under 1 core and 200 MB for 60 players.
- Image: Ubuntu 24.04 (or 22.04).
- Add your SSH public key when creating it. Note the public IP address.
- Make sure ports 80 and 443 are open (most providers allow all inbound by default; if there is a cloud firewall, add TCP 80 and 443).

**2. (Skip.)** No extra firewall steps on most providers; the script opens the VM's own firewall.

**3. Get a free address.** On duckdns.org sign in, create a name (for example `hitscan-ammar`), and set its IP to the VM's public
IP. Your server address is then `hitscan-ammar.duckdns.org`.

**4. Run the setup script.** From PowerShell (the login user is `root` or `ubuntu` depending on the provider):

```powershell
ssh root@<public-ip>      # or ubuntu@<public-ip>, depending on the provider
```

then on the VM:

```bash
git clone https://github.com/Ammar-S-Malik/Hitscan.git && cd Hitscan
./deploy/vm-setup.sh hitscan-ammar.duckdns.org https://YOUR-SITE.pages.dev
```

It installs Node, runs the game server as a service that restarts itself, gets an HTTPS certificate with Caddy, and opens
the VM's own firewall. (A private repository needs a GitHub token in the clone address.) Check it:

```bash
curl https://hitscan-ammar.duckdns.org/health    # prints: ok
sudo systemctl status hitscan                    # active (running)
journalctl -u hitscan -f                         # the log; Ctrl+C to leave it
```

**5. Point the site at it.** In Cloudflare Pages, set `VITE_SERVER_URL=wss://hitscan-ammar.duckdns.org` and redeploy.
`ALLOWED_ORIGINS` (the second argument above) must match your Pages address exactly, including `https://`. If you used a
placeholder at first, run the script again with the right one.

**Updating the server later** (the service runs from `/home/hitscan/app`, a separate copy from the one you cloned to run the script):

```bash
sudo -u hitscan git -C /home/hitscan/app pull
sudo -u hitscan bash -c 'cd /home/hitscan/app && npm ci --omit=dev'
sudo systemctl restart hitscan
```

**Things that can go wrong**
- **The address changes if you delete and recreate the VM.** Update the DuckDNS entry.
- **"Connection refused" or a certificate error** almost always means port 80 or 443 is closed in one of the two firewalls
  (the provider's, or the VM's own, which the script opens) or DuckDNS points at the wrong IP. Caddy needs port 80 reachable to get the certificate.

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

## 3. Accounts (optional, Firebase)

Players can always play as guests. If a Firebase project is configured, the menu also offers **Sign in**
(Google, or email and password), and a signed-in player's name, class and stats are saved to Firestore.
With no Firebase settings the sign-in button simply doesn't appear.

1. In the [Firebase console](https://console.firebase.google.com) create a project (Analytics is not needed).
2. **Authentication** > Get started > Sign-in method: enable **Google** and **Email/Password**.
3. Authentication > Settings > **Authorized domains**: add your Pages addresses, for example `hitscan.pages.dev`
   (and `hitscan-8gk.pages.dev` or any preview address you use). `localhost` is there already.
4. **Firestore Database** > Create database (production mode, any nearby location). Then Rules: paste the
   contents of `firestore.rules` from this repo and Publish.
5. Project settings > General > Your apps > add a **Web** app (no Hosting). Copy `apiKey`, `authDomain`,
   `projectId` and `appId` into Cloudflare Pages as `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_APP_ID`, then redeploy. These values are public by design;
   the Firestore rules are what keep each player's data private.

The Firebase SDK is loaded from Google's CDN on page load only when these are set.

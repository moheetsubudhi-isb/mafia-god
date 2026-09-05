# Mafia — God Console

A self-hostable Mafia / Werewolf moderator. The **server is "God"**: it deals secret
roles, runs the night phase, and resolves kills, saves, and investigations. Day-time
discussion and voting happen on **WhatsApp**; the host types the verdict into the console.

- **Host screen** = the God console (sees every role, drives the game).
- **Player screen** = their secret role + private night actions.
- **Dead players** = spectators with full god-view.
- **Roles:** Mafia, Doctor, Detective, Villager (host sets how many of each).

---

## 1. Run it locally (to try it out)

You need [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Open `http://localhost:3000`. To test alone, open several browser tabs
(one "Host a game", the rest "Join a game" with the 4-letter code).

Minimum 4 players. The host does **not** play — they're God.

---

## 2. Deploy on your VPS

### Option A — Simplest (just a port)

Good for a quick game night. No domain needed.

```bash
# on the VPS
sudo apt update && sudo apt install -y nodejs npm
git clone <your-repo>  # or upload the folder with scp
cd mafia-god
npm install
npm install -g pm2          # keeps it running after you log out
pm2 start server.js --name mafia
pm2 save && pm2 startup     # (run the line pm2 prints, to survive reboots)
```

Now open port 3000 in your firewall and share `http://YOUR_VPS_IP:3000`.

```bash
sudo ufw allow 3000
```

> Note: this is plain HTTP. Fine for friends; for a "real" link use Option B.

### Option B — Proper domain + HTTPS (recommended)

Point a domain (e.g. `mafia.yoursite.com`) at your VPS, then put Nginx in front.

```bash
sudo apt install -y nginx
```

Create `/etc/nginx/sites-available/mafia`:

```nginx
server {
    server_name mafia.yoursite.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # these three lines are REQUIRED for Socket.IO (WebSockets)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

Enable it and add a free HTTPS certificate:

```bash
sudo ln -s /etc/nginx/sites-available/mafia /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mafia.yoursite.com   # auto-configures HTTPS
```

Share `https://mafia.yoursite.com`. Done.

Keep the app itself running with pm2 (same as Option A).

---

## 3. How to run a game night

1. You open the site → **Host a game** → set role counts → **Create room**.
2. Share the 4-letter code (drop it in the WhatsApp group).
3. Friends open the site → **Join a game** → code + name.
4. When everyone's in, hit **Deal roles & begin night**.
5. Each night the app privately collects mafia/doctor/detective actions; you hit
   **Resolve night** and it announces who died.
6. Everyone discusses + votes on **WhatsApp**; you enter who was voted out.
7. Repeat until the app declares Town or Mafia the winner.

---

## Sending roles on WhatsApp

When players join they can enter a WhatsApp number (with country code, no `+`).
On Night 1 the host console shows a **Send roles on WhatsApp** panel: one button
per player that opens a pre-filled WhatsApp chat with their secret role.

Important: `wa.me` links **cannot auto-send** — they open a draft and *you press
Send*. So this is one tap (+ send) per player, not an automatic blast. For 10–15
players that's about a minute. Players who skip the number get a **Copy role**
button instead, so you can paste it to them yourself. The on-screen secret role
still works regardless, so WhatsApp delivery is a convenience, not a requirement.

Numbers are only ever visible to the host and are never sent to other players.

## Notes & knobs

- Rooms live in memory — if the server restarts, in-progress rooms are gone.
- The host leaving closes the room. (Players dropping mid-game stay in.)
- Change the port with `PORT=8080 npm start`.
- v2 ideas (not built yet): in-app chat, per-phase timers, reconnect, more roles.

# BLAH

A dead-simple, early-internet-style chat room packaged as an umbrelOS app.
No accounts, no passwords, no database. Open it from any device that can
reach your Umbrel, pick a name, and start typing — everyone with the app
open sees the same room.

- Retro terminal look (green on black, monospace)
- Live messages over server-sent events, with a polling fallback
- Username = whatever you type in once (a device name like `MacBook-Pro`
  works great); it's remembered by that browser
- Shows how many chat windows are online
- History (last 200 messages) is stored on your Umbrel and survives
  restarts; anyone in the room can wipe it with the clear button or by
  sending `/clear`

## Install on your Umbrel (umbrelOS 1.x)

Umbrel installs community apps from a git repo it can reach over plain
https, so this repo needs to live somewhere your Umbrel can clone it —
GitHub is the easiest.

**1. Push this repo to GitHub**

Create a new **public** repository at https://github.com/new (e.g.
`blah-app-store`, don't initialize it with a README), then from this
folder:

```bash
git remote add origin https://github.com/<your-username>/blah-app-store.git
git push -u origin master
```

(The repo has to be public — umbrelOS clones it without any login.)

**2. Add the store on your Umbrel**

Dashboard → **App Store** → **⋯** (top-right) → **Community App Stores** →
paste your repo URL → **Add**.

Or over SSH (`ssh umbrel@umbrel.local`, password = your dashboard password):

```bash
sudo umbreld client appStore.addRepository --url https://github.com/<your-username>/blah-app-store
```

**3. Install**

Open the **BLAH App Store**, click **BLAH → Install**. The app image is
built on the Umbrel itself during install, so the first install takes a
minute or two.

**4. Chat**

Open BLAH from the dashboard, or skip the dashboard entirely and go to
**http://umbrel.local:3747** on any device on your network — your MacBook,
your roommate's PC, phones, whatever. Each person types a name once and
it's remembered by that browser.

## Notes

- **No login, by design.** `PROXY_AUTH_ADD: "false"` in
  `blah/docker-compose.yml` turns off Umbrel's login wall so anyone on your
  LAN can open the chat. If you'd rather have Umbrel's login protection,
  delete that line and reinstall.
- "online" counts open chat windows, not people.
- To update after changing the code: push to GitHub, bump `version` in
  `blah/umbrel-app.yml`, and the dashboard will offer an Update button
  (umbrelOS re-checks app stores every few minutes).
- The dashboard icon works once you add this line to `blah/umbrel-app.yml`
  (with your real GitHub username/repo) and push:

  ```yaml
  icon: https://raw.githubusercontent.com/<your-username>/blah-app-store/master/blah/icon.svg
  ```

  The app works fine without it; the tile just shows a placeholder.
- Also update the `website`/`repo`/`support` URLs in `blah/umbrel-app.yml`
  to your real repo URL when you get a chance (cosmetic only).

## Fallback: run it without the app store

If you don't want the GitHub detour, you can run BLAH as a plain Docker
container. Copy the `blah/` folder to your Umbrel, then over SSH:

```bash
cd ~/blah
docker build -t blah .
docker run -d --name blah --restart unless-stopped -p 3747:3000 \
  -e DATA_DIR=/data -v blah-data:/data blah
```

Chat is at http://umbrel.local:3747. Downsides: no dashboard tile, and
umbrelOS updates may remove containers it doesn't manage.

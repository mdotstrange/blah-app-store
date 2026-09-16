# BLAH

A dead-simple, early-internet-style chat room packaged as an umbrelOS app.
No accounts, no passwords, no database. Open it from any device that can
reach your Umbrel, pick a name, and start typing — everyone with the app
open sees the same room.

- Dressed up like a 1990s instant messenger: blue title bar, grey beveled
  buttons, white message pane, buddy list, Win98-style menus
- Live messages over server-sent events, with a polling fallback
- Username = whatever you type in once (a device name like `MacBook-Pro`
  works great); it's remembered by that browser
- Buddy list showing who is signed on, plus a count of open chat windows
- Text sizer (A- / A+) and font picker, remembered per browser
- Desktop notifications: a popup with the sender and message when the chat is
  in a background tab (click it to jump back to the tab and reply)
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
it's remembered by that browser, via the little sign-on dialog.

For notifications, open it at **https://umbrel.local:3747** instead: browsers
only allow notifications on secure addresses. umbrelOS serves every app port
over HTTPS as well as HTTP using its own local certificate authority, so you
either accept the certificate warning the first time or install Umbrel's CA
certificate from the dashboard. Plain http still works fine, it just can't
pop up notifications.

## Notifications

Click **notify** in the header and allow the browser's permission request.
From then on, whenever a message arrives while the BLAH window is in the
background (another tab, another app, screen off), you get an OS notification
with the sender and the message. Clicking it brings the tab back to the front
with the cursor in the input box, ready to reply.

- It stays quiet while you're actually looking at the room, so you don't get
  popups for messages you're already reading. Tabs that are open but not
  focused (the "Chrome in the background" case) do notify.
- The toggle is remembered per browser, and the button shows the current
  state: `notify off`, `notify on`, `notify blocked` (permission denied in the
  browser's site settings) or `notify n/a` (opened over plain http, so the
  browser has no notification support).
- The tab title shows an unread count, like `(3) BLAH`, and clears when you
  come back to the tab. That works even without notifications.
- `requiresHttps: true` in `blah/umbrel-app.yml` is what makes the dashboard
  open BLAH over HTTPS. If you'd rather stick to plain http, delete that line
  and reinstall — everything except notifications still works.
- On iPhone and iPad, Safari only shows notifications for web apps added to
  the home screen, not for a normal tab.

## Around the window

- **Buddy list** (right hand panel) shows everyone signed on, each with their
  own name colour. Names come from open browser windows and disappear when
  they close; the number in the panel header counts windows, so two windows
  using the same name count twice.
- **Text sizer**: `A-` / `A+` next to the font dropdown, or
  **View → Bigger / Smaller / Reset text size**. Default is bigger than the
  old terminal look used to be, and the size, the font and the buddy-list
  toggle are all remembered by your browser.
- **Menus**: `File` (rename, clear history, sign off), `View` (text size, font,
  buddy list, notifications), `Insert` (emoticons and the `/clear` command),
  `People` (who's here, rename).
- **Sending**: type and press Enter, or click **Send**. Your own messages are
  lightly tinted so they are easy to spot.
- `B`, `I`, `U` and the colour swatch in the toolbar are decoration — BLAH
  messages are plain text, and each name gets its own colour automatically.
  The title bar buttons are decoration too, and the taskbar button jumps your
  cursor to the message box.

## Notes

- **No login, by design.** `PROXY_AUTH_ADD: "false"` in
  `blah/docker-compose.yml` turns off Umbrel's login wall so anyone on your
  LAN can open the chat. If you'd rather have Umbrel's login protection,
  delete that line and reinstall.
- "online" counts open chat windows, not people: each tab, phone, or laptop
  with the chat open counts once, even when two of them pick the same name.
- Flood control is deliberately gentle: a name can send 15 messages per 10
  seconds and `/clear` has a 3 second cooldown, so one window can't blank the
  room or flood it on a loop. Renaming resets the message budget, so treat it
  as a speed bump rather than a ban.
- To update after changing the code: push to GitHub, bump `version` in
  `blah/umbrel-app.yml`, and the dashboard will offer an Update button
  (umbrelOS re-checks app stores every few minutes).
- The dashboard icon comes from `blah/icon.svg` over its raw GitHub URL, so it
  only appears once the repo is public. Until then the tile shows a
  placeholder and the app still works.

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

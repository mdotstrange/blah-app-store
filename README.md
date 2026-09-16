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
- Shared to-do list: anyone in the room can add tasks, tick them off (they get
  struck through), edit them or delete them
- Calendar under the checklist with today highlighted; task creates and edits
  are marked on the day they happen, and anyone can leave a note on a day
- Text sizer (A- / A+) and font picker, remembered per browser
- Desktop notifications: a popup with the sender and message when the chat is
  in a background tab (click it to jump back to the tab and reply)
- File sharing: drag a file onto the window and everyone sees a chip with the
  file's name, size and an icon; click it to download
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
- **To Do** (below the buddy list) is one list shared by the whole room. Type a
  task and press **Add**; tick the checkbox to strike it through, use the
  pencil to edit in place (Enter saves, Esc gives up), and the ✕ to delete it.
  The header shows how many are still open.
- **Calendar** under that: today is highlighted in blue, days where a task was
  created or edited get a red dot, and days with a note get a green one. Click
  a day to see what changed on it and to leave a note — notes are per day and
  shared with everyone. ◀ ▶ page through the months.
- **Resizing**: drag the divider on the left of the side panel to make the whole
  column wider (the calendar cells grow with it), and drag the divider above the
  calendar to make the calendar taller. Double-click either divider — or use
  **View → Reset panel sizes** — to go back to the automatic size. Both sizes
  are remembered by your browser.
- The to-do list, its history and the day notes live in `blah/data/board.json`
  next to the chat history, so they survive restarts and app updates. Deleting
  a task also removes its calendar entries.
- **Text sizer**: `A-` / `A+` next to the font dropdown, or
  **View → Bigger / Smaller / Reset text size**. Default is bigger than the
  old terminal look used to be. It sizes the whole thing — chat messages, task
  text and checkboxes, the Add a task box, the calendar's month, day numbers and
  weekday row, the day note box and the Save note / Clear buttons — kept in
  proportion so the side panel stays readable at every setting. The size, the
  font and the panel toggles are all remembered by your browser.
- **Menus**: `File` (rename, clear history, sign off), `View` (text size, font,
  buddy list, notifications), `Insert` (emoticons and the `/clear` command),
  `People` (who's here, rename).
- **Title bar buttons** work: `□` maximises (fills the screen, and the side
  panel widens with it), `_` puts the window back to its default size, and
  double-clicking the title bar does the same as maximise. Your choice is
  remembered. `✕` signs you off, same as **File → Sign off**.
- **Sending**: type and press Enter, or click **Send**. Your own messages are
  lightly tinted so they are easy to spot.
- Messages are plain text — no bold or colours to fiddle with — but each name
  gets its own colour automatically. The taskbar button jumps your cursor to
  the message box.

## Sharing files

Drag a file onto the window — the whole page is a drop target, and it shows a
"Drop files here to share them" outline while you are dragging. Everyone in the
room then sees it in the chat as a chip with a file-type icon, the original file
name and its size. Clicking the chip downloads the file under that same name.
You can drop several files at once, and the sending line appears as you go.

- **They are stored on your Umbrel**, in `blah/data/files/` next to the chat
  history, so they survive restarts and app updates. Clearing the room (or
  `/clear`) deletes them, as does letting a shared file's message fall off the
  end of the 200 message history. Any stray file that no message points at is
  tidied up when the app starts.
- **Limit is 50MB per file** by default. To change it, add `BLAH_MAX_FILE_MB:
  "200"` to the `server` environment in `blah/docker-compose.yml` and reinstall
  (the page picks the new limit up automatically).
- **Downloads are always downloads.** Attachments are served as
  `application/octet-stream` with `Content-Disposition: attachment` and
  `nosniff`, so a shared `.html` or `.svg` can never run inside BLAH's own
  origin. The flip side is that images and PDFs are not previewed in the chat —
  you get the file on your machine and open it there, which is what the chip is
  for.
- Sharing is rate limited to 10 files per 10 seconds per name, alongside the
  message and to-do limits, and at most four uploads are in flight at once.
  Files stream straight to disk as they arrive, so a big one never sits in the
  Umbrel's memory.

## Notes

- **No login, by design.** `PROXY_AUTH_ADD: "false"` in
  `blah/docker-compose.yml` makes "no Umbrel login wall" the default, so anyone
  on your LAN can open the chat. If you'd rather have Umbrel's login
  protection, flip it in BLAH's settings on the dashboard; umbrelOS keeps that
  choice across updates, no reinstall needed.
- **Other websites can't poke the room.** Requests a browser flags as coming
  from another site are refused, the JSON endpoints only accept JSON, and
  uploads need a header a web form can't send. Scripts and `curl` on your LAN
  are unaffected: send `Content-Type: application/json` (and
  `X-Blah-Upload: 1` for uploads).
- The container runs as the unprivileged `node` user (uid 1000), with every
  Linux capability dropped. A small `hooks/pre-start` script hands any data
  written by older, root-running versions over to that user on the first start
  after updating.
- "online" counts open chat windows, not people: each tab, phone, or laptop
  with the chat open counts once, even when two of them pick the same name.
- Flood control is deliberately gentle: a name can send 15 messages per 10
  seconds and `/clear` has a 3 second cooldown, so one window can't blank the
  room or flood it on a loop. Renaming resets the message budget, so treat it
  as a speed bump rather than a ban.
- To update after changing the code: push to GitHub, bump `version` in
  `blah/umbrel-app.yml`, and the dashboard will offer an Update button
  (umbrelOS re-checks app stores every few minutes). Because the image is
  built on the Umbrel rather than pulled by name, each update leaves the
  previous build behind as a dangling image; `docker image prune -f` over SSH
  reclaims the space. Publishing a multi-arch image to GHCR and pointing
  `image:` at it is the tidier long-term setup, and an official-store
  submission would also want screenshots in `gallery`.
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

## Local development (no Umbrel, no GitHub)

`dev.bat` runs BLAH straight out of this folder on your PC, which is the
quickest way to fiddle with the UI before deploying anything:

1. Double-click `dev.bat` (or run it from a terminal). It needs Node.js on your
   PATH — the LTS build from nodejs.org is fine.
2. A browser window opens at **http://localhost:3747/**.
3. Edit `blah/public/index.html` (or `blah/icon.svg`) and press **Ctrl+R** in the
   browser. No restart needed: `dev.bat` sets `BLAH_DEV=1`, which makes the
   server re-read those files on every request. Edits to `blah/server.js` do
   need a restart — Ctrl+C and run it again.
4. Ctrl+C in that console window stops the server.

Worth knowing:

- Notifications work locally too, because browsers treat `localhost` as a
  secure address, so the `notify` button behaves exactly as it does on the
  Umbrel.
- To test two participants (buddy list, shared to-do list, unread counts), open
  a **private / incognito** window as well. Normal tabs share `localStorage`
  and would sign on with the same name.
- Local chat history, to-do list and calendar notes are written to `blah/data/`
  — the same layout the app uses on the Umbrel — and are ignored by git. Run
  `dev-reset.bat` to wipe them and start from an empty room.
- Overrides: `set PORT=3848` or `set BLAH_DATA=D:\somewhere` before running.
- On macOS or Linux the same thing is one line:

  ```bash
  BLAH_DEV=1 PORT=3747 DATA_DIR=blah/data node blah/server.js
  ```

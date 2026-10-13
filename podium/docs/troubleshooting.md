# Podium Troubleshooting & Diagnostics

This guide covers connection diagnostics, cache and build discrepancies, device reset procedures, and emergency keyboard shortcuts for Podium.

---

## 1. Connection & Relay Diagnostics

Podium controllers and displays communicate through an encrypted relay channel. The controller top bar reports two distinct states:

*   **`Relay OK`**: The device successfully reached your relay server (Supabase, self-hosted Node server, or MQTT broker). This does *not* indicate whether the display is reachable.
*   **`Display connected`**: A display in the same room, configured with the identical passphrase, is active and publishing heartbeat messages. This confirms end-to-end communication.

```mermaid
flowchart LR
    C[Controller] -- 1. Connects to Relay --> R((Relay / Broker))
    D[Display] -- 2. Connects to Relay --> R
    R -. 3. Relays Encrypted Messages .-> C
    R -. 3. Relays Encrypted Messages .-> D
```

### When the controller says the display isn't there

If you see `Relay OK` alongside `No display connected`, check the following common causes in order:

1.  **The display is open, but nobody clicked "Go live"**:
    *   The controller displays: *"Display open — click Go live on it"*.
    *   On the classroom PC, click the large **Go live** button (or press `G`). Browsers prohibit entering fullscreen, acquiring the Screen Wake Lock, and autoplaying audio without a direct user gesture.
2.  **Room name or passphrase mismatch**:
    *   Both devices generate a 4-character verification code from the room name and passphrase.
    *   Compare the 4-character code on the controller's top bar with the code on the display's standby/arming screen.
    *   If they differ, tap **Pair a device** on the display and re-scan the QR code.
3.  **Different transports selected**:
    *   Both devices must use the same transport type (e.g., both on Supabase, or both on Self-Hosted WebSocket). A controller on MQTT and a display on Supabase will both report `Relay OK` but will never exchange messages.
4.  **Stale settings from earlier sessions**:
    *   If a device was previously used in another room or test environment, click **Clear settings & reload** in Settings.
5.  **"Wrong passphrase somewhere"**:
    *   If encrypted traffic arrives that a device cannot decrypt, the controller shows a warning banner indicating a cryptographic key mismatch.

---

### Understanding Relay Status Messages

Both the display and controller provide plain-language status logs indicating the dialled URL and connection state:

| Message | Root Cause & Resolution |
| :--- | :--- |
| `could not open wss://… (code 1006)` | The WebSocket handshake failed. Common causes:<br>1. Relay server is stopped or port is blocked by campus firewall.<br>2. **Self-signed TLS certificate untrusted**: Open the relay host in an HTTPS browser tab once (`https://your-relay:8080`), accept the certificate warning, and reload Podium. |
| `dropped (code 1006), attempt N` | An established connection was interrupted (Wi-Fi roaming, network drop, or server restart). Podium will automatically retry and back off. |
| `never connected to wss://broker…` | The public MQTT broker refused the connection. Ensure the WebSocket port and path are correct (e.g., `wss://broker.emqx.io:8084/mqtt`). |
| `"my-vps/podium" is not a URL` or `must start with wss://` | Formatting error in Settings. A browser cannot dial raw TCP sockets (`mqtt://host:1883`); it must use a WebSocket endpoint (`wss://...`). |
| `This page is served over https://, so the browser blocks a plain ws:// relay` | **Mixed Content violation**. Secure `https://` pages are prohibited from opening unencrypted `ws://` sockets. Use `wss://` with a valid TLS certificate. |
| `Could not load the MQTT client from cdn.jsdelivr.net` | The external CDN is blocked by institutional network filtering. Switch to the self-hosted WebSocket relay, which requires zero CDN dependencies. |

---

## 2. Versioning & Stale Build Detection

Podium tracks two identifiers defined in [`assets/js/protocol.js`](../assets/js/protocol.js):

*   **Version** (e.g., `1.1`): The semantic release number.
*   **Build** (e.g., `23`): An auto-incrementing integer tracking individual deployments.

### Where to inspect your build number

*   **Controller**: Open **Settings** (or inspect the top bar: `Display connected · 120 ms · build 23`).
*   **Display**: Open **Settings**, located next to *Clear settings & reload*.
*   **Planning page**: Located in the footer.
*   **Server health check**: Query `GET /healthz` (returns something like `ok Podium 1.3, build 117, 2 rooms, 0 polls`).
*   **CLI diagnostics**: Run `podium-admin doctor`.

### Stale build detection & cache busting

Because the controller and display run as independent web clients, one device may run outdated cached JavaScript while the other runs a newer build. This split-brain state can cause subtle UI glitches or message parsing failures.

*   **Automatic Controller Alert**: If the display reports a different build number, the controller displays an alert banner:
    > *"Display is on build 21, this is build 23 — reload the display."*
*   **Self-Cache Validation**: On load, each client fetches its own source with cache bypassing. If an older build is running from the browser cache, a banner offers a **Reload now** button with automated cache busting (`?fresh=...`).
*   **Manual Cache Busting**: Perform a hard refresh:
    *   **macOS**: `Cmd + Shift + R`
    *   **Windows / Linux**: `Ctrl + Shift + R`
*   **Server Caching Header**: When hosting Podium via Nginx, Caddy, or Node, ensure HTML and JavaScript files are served with:
    ```http
    Cache-Control: no-cache
    ```

---

## 3. Starting a Device Over (Reset Procedures)

Settings (room name, passphrase, custom faders, saved layouts) are stored in client `localStorage`.

### Surgical Reset

Clicking **Clear settings & reload** at the bottom of the Settings sheet safely resets the client without wiping unrelated browser data:

*   Deletes only keys matching `podium.*` in `localStorage`.
*   Clears cookies scoped to the current path.
*   Unregisters the Podium Service Worker (`sw.js`).
*   Purges the Cache Storage API cache for Podium assets.
*   Leaves other projects sharing the same domain (e.g., other repositories on `username.github.io`) untouched.

### Offline Shell (`sw.js`)

Podium uses a **network-first** service worker. Under normal conditions, assets are retrieved from the network. If the device loses connectivity, cached core assets (`display.html`, `control.html`, `podium.css`, `protocol.js`, etc.) allow the controller to operate offline.

If an asset fails to update despite refreshing:
1. Open Developer Tools (`F12`).
2. Go to **Application** &rarr; **Service Workers**.
3. Click **Unregister** and check **Bypass for network**.
4. Hard reload the page.

---

## 4. Classroom Display Keyboard Shortcuts

When the display runs fullscreen on the classroom PC with browser controls hidden, use the physical keyboard to access emergency controls:

| Key | Action | Details |
| :--- | :--- | :--- |
| `?` | **Help / Shortcuts** | Toggles the shortcut cheat sheet modal. |
| `G` | **Go Live** | Arms the session, enters fullscreen, locks awake state, and enables sound. |
| `F` | **Toggle Fullscreen** | Enters or leaves native browser fullscreen. |
| `E` | **End Session / Standby** | Exits fullscreen and returns to the standby arming screen while retaining current slides/state in memory. |
| `B` | **Back to Home** | Saves current state and navigates back to `index.html`. |
| `P` | **Pairing QR** | Toggles display of the 90-second pairing QR code. |
| `S` | **Settings** | Opens the connection and display settings panel. |
| `Esc` | **Close** | Dismisses any open overlay, modal, or shortcut card. |

> [!NOTE]
> Shortcut keybindings are disabled when focused inside input fields (such as typing room names or passphrases in Settings).

---

## 5. Web Pages

### A web page shows "… refused to connect" or a sad face
The site will not let other sites show its pages inside them. GitHub, Google, most news sites and every learning-management system send `X-Frame-Options` or a `frame-ancestors` rule that says so, and the browser obeys. No setting in Podium (or any other web page) can get around it.
- **On your own server, use the live browser.** With Chromium installed (see [vps.md](vps.md#the-live-browser)), a page on another site opens in the server's own browser instead of a frame. Set the item to **Show it as: Live browser** (or *Automatic*) in the planner, or with **Show this page as** on the Now tab. You also get to click, scroll and type into it from the controller.
- **Without a server**, Podium shows a card instead of the sad face for the sites it knows refuse. For the others, open the page in a tab of its own on the classroom computer, or put up a QR code of it for the class.

### The live browser says it is not available, or pages only ever embed
- `podium-admin doctor` has a **live browser** line saying whether the server found Chromium. The service log says it at startup too (`podium live browser: …`). Chromium installed after the server started needs `systemctl restart podium`.
- It is only offered on a server with accounts, to a signed-in controller or display (or a kiosk).
- **Chromium would not start (… No usable sandbox!)** in the service log: see *The sandbox* in [vps.md](vps.md#installing-chromium-for-the-live-browser).
- **That address is on a private network**: the live browser does not open `localhost`, `10.x`, `192.168.x` and similar addresses unless `BROWSER_ALLOW_PRIVATE=1`.
- **The live browser already has 4 pages open**: close one, wait for one nobody is watching to close itself (10 minutes), or raise `BROWSER_MAX_SESSIONS`.

### The live page says "This site can't be reached" (ERR_TUNNEL_CONNECTION_FAILED)
Every connection a live page makes goes through a guard inside the Podium server, which refuses addresses on private networks. `ERR_TUNNEL_CONNECTION_FAILED` is Chromium saying the guard did not open the connection. The guard says why in three places:
- **On the controller**: the line under the page reads *That page did not open: …* with the reason.
- **In the service log**: one line per address, at most once a minute:
  ```
  journalctl -u podium --since "15 min ago" | grep "live browser"
  ```
  For example: `live browser: did not open github.com:443 - github.com:443 could not be reached from this server (140.82.112.3: ETIMEDOUT) - …`
- **`podium-admin doctor`** (`sudo -u podium node /opt/podium/current/server/podium-admin.js doctor`): its **web access** line tries `github.com` through the same guard, with the same settings, and says whether a page could open it.

What the reason means:
- **could not look … up**: the server's own name lookups fail. Podium asks the system's lookup first, then the DNS servers in `/etc/resolv.conf` directly; when both fail, the reason shows both, as in `EAI_AGAIN; asking its DNS servers directly: ECONNREFUSED`.
  - **`EAI_AGAIN` for every address, at once** (often Chrome's own `update.googleapis.com` and similar as well as the page): the Podium service cannot resolve names at all, even if the rest of the server can. Compare the server, the service account, and the service's own sandbox:
    ```
    getent ahosts github.com
    sudo -u podium getent ahosts github.com
    sudo systemd-run --pipe --wait -p User=podium -p ProtectSystem=strict -p ProtectHome=true -p PrivateTmp=true getent ahosts github.com
    ls -l /etc/resolv.conf; cat /etc/resolv.conf; grep '^hosts' /etc/nsswitch.conf
    systemctl cat podium
    ```
    The first that fails says where: the whole server (DNS itself), only the `podium` account (often an `/etc/resolv.conf` it cannot read), or only inside the service (settings in `systemctl cat podium` such as `IPAddressDeny=`, `RestrictAddressFamilies=` or `PrivateNetwork=`, or a name-service module in `/etc/nsswitch.conf` the sandbox blocks).
  - **`ENOTFOUND`**: that one name does not exist, or the server's DNS does not know it.
- **resolves to …, which is a private or reserved address**: the name came back as an address inside a private or reserved range. Some DNS filters, VPNs and "fake IP" proxy setups do this. Fix the DNS, or set `BROWSER_ALLOW_PRIVATE=1` if pages on that network should be reachable.
- **could not be reached from this server (… ETIMEDOUT, ECONNREFUSED, ENETUNREACH)**: the server cannot connect out directly. Try `curl -sI https://github.com` on the server. A firewall may be blocking outgoing connections, or the network may only reach the internet through a proxy. If so, set `BROWSER_UPSTREAM_PROXY=http://proxy.example.edu:3128` in `podium.env` and restart. Pages then go out through that proxy, still under the private-address rule.

After changing `podium.env`: `sudo systemctl restart podium`.

### The live page has no sound
On purpose: the live browser is silent. Play the video through Podium's own **Video**, **YouTube** or **Live stream** item, which the mixer controls, or set the page to **Embedded** (if the site allows framing).

---

## 6. Recording, Replay, Search & Attendance (Your Own Server)

These all need Podium's own server with accounts (see [vps.md](vps.md)).

### "Go live and record the screen" isn't on the Go live screen
- An administrator hasn't turned it on: **Admin › Server › Screen video**. It is off by default.
- The display is a **kiosk**, or the page is Guest View. Neither ever records.
- The browser can't record a tab. Use a current Chrome or Edge on the classroom PC.

### The screen recording stopped by itself
The badge in the corner of the projector says why:
- **Sharing this tab was ended:** someone pressed the browser's own *Stop sharing*.
- **This lecture has kept as much video as the server allows:** the per-lecture limit on **Admin › Server › Screen video** was reached. Raise it for long lectures, after checking the server's disk.
- **This server no longer keeps screen video:** an administrator turned it off mid-lecture.

### The replay has no sound
- Only the controller mic records sound, and only with **Record this mic to the session** on (the controller's **Say** tab). The replay says "No microphone was recorded in this lecture" when there was none.
- Screen video records the display tab's own sound (videos and music), not the room.

### The replay's sound is a little out of step with the slides
- Mic segments carry the controller's own clock. A controller whose clock is off by some seconds is off by the same amount in the replay. Setting the device to set its time automatically fixes it for future lectures.
- Recordings made before 1.3 are placed from when recording began, two minutes per segment, so they can drift by a second or so across a long lecture.

### A search finds nothing
- Search matches whole words (ignoring case, accents and word endings). Use `memor*` for "memory", "memorise" and "memorable"; put a phrase in quotes only if those words were said in that order.
- It only covers sessions you could already open: your own, and your courses' while the course isn't archived.
- Only what was recorded can be found: captions (if they were on), what was on screen, notes, polls, and attendance questions.

### A student's attendance code is refused
- The code changes every 10–30 seconds and is accepted for one change after it leaves the screen. A photo of the screen sent to someone outside goes stale almost at once, which is the point. Ask them to scan the screen itself.
- Too many wrong codes from one phone are slowed down for a minute.
- With **Only from phones in the room** on, a phone that is too far away, or won't share its location, is refused with the reason. Indoors a phone's location can be 50 m or more out; a larger radius helps. Either way, the student can be marked by hand.

### Attendance receipts aren't arriving by email
- Check that mail is set up: **Admin › Server › Attendance** says so, and **Send a test email** tries it. `podium-admin doctor` checks it too.
- The course's own switch must be on: **Email each student a receipt when they check in**, on **My Files › Attendance**.
- A receipt goes to the roster's email address (or the one a guest typed). A student with no address on the roster gets none.

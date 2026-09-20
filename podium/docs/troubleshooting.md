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

Podium tracks two identifiers defined in [`assets/js/protocol.js`](file:///Users/jon/projects/git/useful-scripts/podium/assets/js/protocol.js):

*   **Version** (e.g., `1.0`): The semantic release number.
*   **Build** (e.g., `23`): An auto-incrementing integer tracking individual deployments.

### Where to inspect your build number

*   **Controller**: Open **Settings** (or inspect the top bar: `Display connected · 120 ms · build 23`).
*   **Display**: Open **Settings**, located next to *Clear settings & reload*.
*   **Planning page**: Located in the footer.
*   **Server health check**: Query `GET /healthz` (returns `ok Podium 1.0, build 23, ...`).
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

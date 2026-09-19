# GuguTV

An MVP Chrome/Chromium extension and Go WebSocket relay for synchronizing ordinary HTML5 video controls. It relays playback events only; video data continues to come from the site or local file selected in each browser.

The relay is deployed at `https://gugutv.onrender.com` (WebSocket endpoint `wss://gugutv.onrender.com/ws`); the extension is preconfigured to use it, so you only need to serve the test page and load the extension.

## Run locally

1. Serve the test page from the repository root:

   ```sh
   python3 -m http.server 8081
   ```

2. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension` directory.
3. Open `http://localhost:8081/test-page/` in two separate browser profiles (or two computers). Select the same video file in each window.
4. Use the extension popup in each browser to join the same room ID. A room ID may be made up locally, or create one with `curl -X POST https://gugutv.onrender.com/rooms`.

Note: the deployed relay is on Render's free plan and spins down after periods of inactivity, so the first connection after a while may take several seconds to wake it up.

### Running the relay locally instead

```sh
cd server
go mod tidy
go run .
```

Then temporarily point `DEFAULT_SERVER_URL` in `extension/background.js` back to `ws://localhost:8080/ws` and add `http://localhost:8080/*` to `host_permissions` in `extension/manifest.json`.

Play, pause, and completed seeks are relayed to the other participant. The relay automatically creates a valid room on first WebSocket join, reconnects clients with exponential backoff, and sends the latest room state after reconnecting.

## Tests

```sh
cd server
go test ./...
```

## Development notes

- The extension is intentionally scoped to `localhost:8081`, `127.0.0.1:8081`, and `hotstar.com`; expand the manifest deliberately when adding supported sites.
- This is a generic HTML5 video adapter, not a DRM bypass, proxy, downloader, or restreamer.
- The server uses in-memory rooms and no authentication, which is appropriate only for local development.

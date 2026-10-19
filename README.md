# Form Sync

Plays videos of the same motion side by side, lined up on a key moment, with frame-by-frame stepping. It comes set up for tennis serves (synced on the toss release) and basketball jump shots (synced on the release).

## Run

Requires [Node.js](https://nodejs.org) (no other dependencies).

1. Put your clips (`.mp4`, `.mov`, `.m4v`, `.webm`) in the folder for their shot type:
   - `data/tennis-serve/`
   - `data/basketball-jumpshot/`
2. Start the server:
   ```
   npm start
   ```
3. Open http://localhost:8765 and pick the shot type in the top-left dropdown.

Stop it with `Ctrl+C`. To use a different port: `PORT=9000 npm start`.

## Use

Each shot type has markers you set per clip:

| Shot type | Markers |
|---|---|
| Tennis serve | `R` release (ball leaves the tossing hand), `C` contact |
| Basketball jump shot | `D` dip (bottom of the load), `R` release |

1. Click a clip (or press `1`–`9`), step with `←` `→` to a marker's frame, and press its key. Do this for each marker.
2. Repeat for each clip, then press `Esc` and `Enter`. All clips now line up on the sync marker (choose which with **Sync on** in the top bar).
3. Press `Home` and then `Space` to play every clip in sync from the start.

Each clip glows in a marker's colour on that marker's frame, and the timeline shows when each marker happens relative to the sync marker. `[` and `]` jump between marker moments. Press `?` in the app for all shortcuts.

### Overlay

Press `O` (or **Overlay**) to stack two clips in one frame. Pick the **Base** and **Over** clips in the top bar and set how see-through the top one is with the slider; `S` swaps them.

To line the bodies up, select each clip, press `A`, and click the top of the head and then the ground between the feet, on a frame where the feet are on the ground. The top clip is then scaled to the same height with its feet on the base clip's feet. Without points, drag and scroll the top clip into place by hand.

Settings are saved to `data/<shot type>/sync.json`.

## Add a shot type

Add an entry to `sports.json` with its markers (id, label, key, colour, hint) and which marker to sync on, then restart the server. It gets its own folder under `data/`.

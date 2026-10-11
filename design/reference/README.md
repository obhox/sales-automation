# Design reference

`linki-ui.html` is the design the UI is built from: Joy's Pencil export of 10 October 2026 (a sidebar and 18 screens, each 1440×1024, on one canvas). The mock's product name "Relay", the workspace "Acme Growth" and its people and numbers are placeholder copy; the product is Linki.

It is reference material only. It is kept out of the Docker image and out of lint, and nothing in the app imports it.

## Looking at a screen

Start the `design` entry in `.claude/launch.json` (a static server on port 4310), then open:

- `http://localhost:4310/` for the list of frames
- `http://localhost:4310/?frame=02%20Campaigns` for one frame at its real size

Every node carries a `data-pencil-name`, so a screen's structure can also be read with a text search, for example `grep -n 'data-pencil-name="06 Inbox"' linki-ui.html`.

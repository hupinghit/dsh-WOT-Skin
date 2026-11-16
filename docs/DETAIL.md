# World of Tanks wallpaper

Paints official *World of Tanks* artwork behind the DeepSeek Harness web GUI and
changes the picture once a day.

## What it does

- **Source** — the official World of Tanks media gallery (`worldoftanks.eu`,
  wallpaper tag). Only art published there is used; nothing is bundled or
  scraped from third-party sites.
- **At most one download a month** — the host half checks the stash on start and
  whenever the GUI asks for its state. If the newest batch was fetched less than
  30 days ago, nothing is downloaded. A refresh is also skipped for an hour after
  a failure, so a flaky network cannot hammer the official site.
- **About ten pictures kept** — the ten best tank-scenario wallpapers of the
  listing are downloaded at 1920×1080 (falling back to 2560×1440 and other
  official sizes). Promo collages and character portraits are ranked last, so the
  stash stays tank-themed. Old files are deleted when a new batch lands.
- **One picture per day** — the picture of the day is a pure function of the
  local date, so it changes at local midnight and is identical on every window.
  The control bar's arrows shift the sequence without touching the daily rhythm.

## Where things live

| | |
| --- | --- |
| images | `$DSH_HOME/cache/wot-wallpaper/images/<slug>.jpg` |
| state | `$DSH_HOME/cache/wot-wallpaper/state.json` |

`$DSH_HOME` defaults to `~/.dsh`. Deleting the folder is safe: the next refresh
downloads a fresh batch.

## Control bar

A 26 px bar at the bottom edge of the window:

| control | effect |
| --- | --- |
| `‹` / `›` | show the previous / next picture (the daily rotation continues tomorrow from the new offset) |
| `⟳` | download now, ignoring the 30-day interval |
| `✕` | turn the wallpaper off (keeps the stash); the bar then offers *Turn on* |

Hovering the title shows the picture name and its original URL.

## HTTP surface

Served by the host half on the GUI's own origin, so the browser needs no extra
permission:

| route | |
| --- | --- |
| `GET /wot-wallpaper/state` | JSON: whether it is on, the picture list, today's index, last error |
| `GET /wot-wallpaper/img/<id>` | the JPEG/PNG bytes (cached for a week) |
| `POST /wot-wallpaper/action` | `{"action":"next" \| "prev" \| "refresh" \| "enable" \| "disable" \| "reset"}` |

## Notes and limits

- The official European gallery has not published new wallpapers since 2023, so
  a refresh may legitimately return the same ten pictures. The monthly check is
  still the cheapest way to pick up new art if it appears.
- The picture is painted on the window frame itself, and every surface that would
  hide it is turned into glass: the sidebar keeps 40 % of its own fill plus an
  18 px backdrop blur, the right dock and the composer become frosted panels, and
  the centre column adds a light 2.5 px blur over a theme-tinted scrim. Light and
  dark themes both stay readable.
- The theme's own surface tokens are reused, so a different Theme plugin keeps
  working; nothing is hard-coded to one palette.
- Downloading requires the host to reach `worldoftanks.eu`; when it cannot, the
  bar says so and the previously downloaded pictures keep rotating.

# stashhub

![Go](https://img.shields.io/badge/Go-1.22%2B-00ADD8?style=for-the-badge&logo=go&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![GraphQL](https://img.shields.io/badge/GraphQL-E10098?style=for-the-badge&logo=graphql&logoColor=white)
![License](https://img.shields.io/badge/License-AGPL_3.0-df73ff?style=for-the-badge)

A fork of [Stash](https://github.com/stashapp/stash) that adds a TikTok-style
vertical feed, a configurable recommendation algorithm, per-scene likes in
the database, and a dark theme baked into the binary. Everything Stash
already does (ingestion, scanning, scraping, performer and tag management)
is untouched.

- 📱 **TikTok-style vertical feed** at `/`
- 🎛️ **Configurable recommendation algorithm** with five weighted buckets
- ❤️ **Per-scene likes** persisted to the database

<img width="1440" height="900" alt="image" src="https://github.com/user-attachments/assets/a911f8c5-acf4-4d8d-9a89-4c3097ca70ab" />

## Features

- 📱 **TikTok-style vertical feed.** Snap-scroll at `/`. Tap to toggle play, double-tap for fullscreen, arrow keys scroll and seek, the current scene resumes across reloads.
- 🎛️ **Configurable recommendation algorithm.** Five toggleable buckets (hottest, liked, top-rated, stale, random) with per-bucket weights and thresholds. Reshuffles on every Feed open.
- ❤️ **First-class likes.** New `scenes.like_count` column with GraphQL mutations. The heart on both the Feed and the scene detail page writes straight to the database.
- 🔔 **Live notification bell.** Top-right counts for new scenes, unorganized scenes, and performers without an image. Refreshes on focus, visibility change, route change, and every 30 s.
- 🧭 **Sidebar replaces the top nav.** Persistent left sidebar with library tabs and logout pinned to the bottom. Top-right bar holds the bell plus Scenes / Feed shortcuts.
- 🎨 **Modern dark theme in the binary.** Hub-purple accent (`#df73ff`) across cards, scrubber, sliders, dot indicators, and progress strips. No `custom.css` required.
- 🗓️ **Smart date display.** Relative dates ("3 days ago") with the absolute date on hover. Format strings configurable.
- 🔕 **Toast notice toggles.** The websocket-status toast that fires on every brief network blip is off by default and switchable per type.
- 🔐 **No phone-home.** Update check unwired, no telemetry, no donate button.

## Technical details

### Algorithm buckets

| Bucket    | Selection rule                                           |
|-----------|----------------------------------------------------------|
| Hottest   | Scenes tagged with a configurable tag                    |
| Liked     | Scenes with `like_count > 0`, ordered by likes desc      |
| Top rated | Scenes with `rating100` at or above a threshold          |
| Stale     | Scenes whose `last_played_at` is older than N days       |
| Random    | Unfiltered random fallback                               |

Already-viewed scene ids are excluded from the queue. All weights, thresholds, and the hottest-bucket tag live under Settings → Algorithm.

### Likes

Migration 73 adds a `scenes.like_count` column and three GraphQL mutations: `sceneIncrementLike`, `sceneDecrementLike`, `sceneSetLikeCount`. The heart buttons call `sceneIncrementLike` and patch the Apollo cache in place so the count updates without a refetch.

### Notification bell

Each row in the popover links straight to the corresponding filtered list view (e.g. `Scenes` with `organized = false`), as if you had configured the criterion manually. Rows are toggleable individually under Settings → Notifications.

### Other UI changes

- `/login` rewritten as a minimal pill-form layout in `ui/login/login.css`
- Modal footer left-aligned, no top border, no top padding
- Settings and Changelog pages flattened, no nested card chrome
- Pagination buttons rendered as compact chevrons
- Toolbar buttons consistent 35 px pills, 23 px variants attached to the search input
- Tables get soft row dividers instead of borders, empty cells collapse

## Build

```bash
git clone https://github.com/xoorgz/stashhub.git
cd stashhub

# UI bundle
cd ui/v2.5
yarn install
yarn build
cd ../..

# Go binary (needs Go 1.22 or newer)
make stash
./stash
```

### Configuration

stashhub reads the same `config.yml` as upstream Stash and respects the same command-line flags (`-c config.yml`, `--port`, `--host`, `--nobrowser`, `-u ui-location`). First boot writes a default config; everything is editable from the Settings UI.

### Upgrading from upstream Stash

stashhub is a forward fork from Stash `v0.28.1` plus migration 73. Pointing stashhub at an existing Stash database runs the schema migration on first start; a backup is written next to `config.yml`. Downgrading back to upstream Stash after running migration 73 is not supported because the unknown `like_count` column blocks startup.

## License

[AGPL-3.0](LICENSE), same as upstream Stash. All credit for the underlying server, scanner, scraper system, and GraphQL API goes to the Stash maintainers. This repository's changes are limited to UI, theme, the recommendation algorithm, the `like_count` column, and a handful of settings panels.

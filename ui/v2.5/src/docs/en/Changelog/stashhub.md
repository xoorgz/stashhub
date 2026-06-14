### stashhub v1.2.2

* Mobile fix: the feed's double-click-to-fullscreen handler is now gated on
  `matchMedia("(hover: hover)")` so it only registers on pointer devices.
  On touch devices, a quick double-tap near the left or right edge of the
  video was accidentally triggering fullscreen when the user meant to
  edge-tap-seek. Touch users still get fullscreen via the explicit
  fullscreen button in the action stack.

### stashhub v1.2.1

* New **edge-tap seek** in the feed. Tapping the left 10% of the active
  video rewinds 10 seconds, tapping the right 10% advances 10 seconds.
  The middle 80% keeps the existing play/pause toggle. The feedback chip
  uses the same `.feed-pulse` style and central anchor as play/pause, just
  with new back / fwd icons (double-triangle pointing left or right) so
  the four gesture variants feel like one family.

### stashhub v1.2.0

* New **Skip-learning** in the Feed algorithm. Scenes you scroll away from
  with under 5 seconds of playback are now treated as skips: each of their
  tag IDs gets a +1 in `localStorage feed.skips.tags` with a 30-day decay
  on `lastAt`. Before building the queue, `buildQueue()` takes the top 10
  tags by count (minimum 3 skips so a single mis-swipe doesn't ban a tag),
  fetches scenes carrying any of those tags, and adds them to the exclude
  set passed to every bucket fetch. Net effect: the feed quietly stops
  showing tags you keep swiping past.
* New **Adaptive accent**. On every active scene, the poster is downscaled
  to a 16x16 canvas, non-extreme pixels are averaged, and the result is
  boosted in HSL space (saturation x1.45, lightness clamped to 0.35-0.7).
  That colour is written onto the `.feed-item` as `--feed-scene-accent`.
  The action buttons' border picks it up at rest, and on hover the button
  gets a 16 px-radius glow blending 40% of the accent into transparent via
  `color-mix`. Falls back to hub-purple when sampling fails. Cached at the
  module level per poster URL.
* New **Daily wrap card**. Top-of-feed chip shown once per local calendar
  day, summarising yesterday: scene count plus the tag with the highest
  `play_duration` across yesterday's plays. Auto-dismisses after 9 s or on
  the first scroll within the feed track. `localStorage
  feed.wrap.lastShownDay` records the calendar date so it can't reappear
  before tomorrow. Skips entirely if nothing was watched yesterday.
* Buffering loader simplified. The hub-purple ring + buffered percentage
  overlay is removed: the percentage often misrepresented HLS / transcoded
  stream progress and was visually noisy. Stuck tiles now just breathe,
  the poster pulses between opacity 1 and 0.45 via the existing
  `feed-loader-pulse` keyframe.

### stashhub v1.1.0

* Three new feed algorithm buckets driven by real watch behaviour:
  * **Top Watched** (highest default weight). Scenes whose accumulated
    `play_duration` is highest, filtered by a configurable minimum-seconds
    threshold so brief mis-taps don't poison the ranking.
  * **Watched Tags.** Aggregates `play_duration` per tag across your N
    most-watched scenes, then pulls random scenes from the top-scoring tags.
    The "what categories do you actually spend time on" signal.
  * **Favored Tags.** Random scenes from a user-curated tag list. Disabled by
    default; configure under Settings, Feed Algorithm, Advanced, Favored Tags.
* Real `play_duration` tracking in the Feed. Watched seconds are flushed via
  `sceneSaveActivity` every 10 s during play and immediately on pause, end,
  unmount, tab hide, or page unload, with a per-event slice cap of 1.5 s so
  seeking doesn't get counted as watched time.
* Scene detail page now shows total time watched after the like button as a
  stopwatch chip, formatted progressively as `23s`, `5m 23s`, `2h 14m`.
* O button in the feed now triggers a screen-wide drop splash: an 18-drop
  radial burst from the button, plus secondary bursts around the viewport
  centre, with downward-biased trajectories.
* Feed fullscreen button now requests browser/page fullscreen (whole UI goes
  immersive). Double-clicking the video still requests video-element
  fullscreen for the "just the video" mode.
* Scene detail toolbar (the view / O / like / watched / organized chip row)
  now wraps to multiple lines instead of producing a horizontal scrollbar
  when it exceeds viewport width.

### stashhub v1.0.0

* Version bumped to v1.0.0 — well above any upstream Stash release, so the
  built-in version checker no longer reports stashhub as out of date against
  upstream's own release line.
* No functional changes from v0.2.0 in this version. All v0.2.0 features are
  included.

### stashhub v0.2.0

* Feed algorithm renamed to "Feed Algorithm" in Settings.
* New "Top O-Count" bucket: scenes with `o_counter` at or above a configurable
  threshold, ordered by `o_counter` desc.
* Bucket order standardised: Hottest, Liked, Top O-Count, Top rated, Stale,
  Random.
* New "Skip recently played" toggle in the feed algorithm settings. When on,
  scenes with `last_played_at` inside the configured N-day window are excluded
  from every bucket. Default 7 days.
* Feed video robustness: tiles preload aggressively for the active item and the
  two ahead. `canplay`, `waiting`, `stalled`, `error`, and `progress` events
  are wired to retry `load()` and `play()` so a fresh src-swap no longer leaves
  the tile sitting on its poster.
* Buffering loader: when a tile is paused or genuinely stuck buffering, a
  centred ring shows the buffered % with a soft white spinner. The poster
  underneath pulse-fades. The loader is hidden the moment playback resumes,
  and never shows while the video is playing.
* On mobile, the hashtag row clips to one line with a fade-out at the right
  edge instead of stacking up the screen.
* `like_count` is now a filterable and sortable column. Build custom Scenes
  filters by likes (`like_count > 0`, `like_count between 5 and 100`, etc.).
* Pagination redesigned. Direct-click numbered pages with `1 … 5 6 [7] 8 9 … 99`
  layout. The ellipsis is clickable and jumps halfway into the gap. Old
  current-of-total dropdown removed.
* Edit Filter modal restyled. Criterion rows flat with hub-purple hover, no
  Bootstrap card chrome, applied-filter chips repainted hub-purple.
* Feed O button now persists to the database via the `sceneAddO` mutation
  (previous build called the deprecated/non-existent `sceneIncrementO`).
* Feed O button is rate-limited to one press per scene per hour, persisted in
  `localStorage`. Reloads and tab switches do not reset the cooldown.

### stashhub v0.1.0

* Vertical-feed view at `/`. Weighted recommendation algorithm, configurable
  buckets, reshuffled per session.
* Persistent left sidebar replaces the default top navigation. Includes
  logout, settings, stats and library tabs.
* Notification bell in the top-right with live counts:
    * New scenes within a configurable time window.
    * Unorganized scenes.
    * Performers missing an image.

  Counts refresh on focus, visibility change, route change, and every 30
  seconds.
* Per-scene likes persist in the database (new `scenes.like_count` column,
  migration 73). Heart button on the feed and on the scene detail page calls
  `sceneIncrementLike`.
* Feed algorithm settings (Settings &rarr; Algorithm). Five toggleable buckets
  with weights 0&ndash;10:
    * Hottest: scenes tagged with a configurable tag.
    * Liked: scenes sorted by `like_count`.
    * Top rated: rating100 above a configurable threshold.
    * Stale: scenes without a `last_played_at` within the configured window.
    * Random: unfiltered fallback.
* Notifications settings panel (Settings &rarr; Notifications): toggle each
  notification, set the "new scenes" window in hours. Includes a date display
  section: relative dates with an absolute tooltip, configurable date and
  date-time format strings.
* Notices settings panel (Settings &rarr; Notices): toggle UI toasts. The
  websocket status toast is disabled by default.
* Color palette uses `--color-hubs: #df73ff` as the primary accent. Replaces
  Bootstrap and VideoJS defaults across cards, progress bars, the scrubber
  fill, sliders, dot indicators.
* Pagination buttons render as compact chevrons. Toolbar buttons are
  pill-shaped, height 35px. Buttons attached to the search input are 23px.
* Modal footer is left-aligned with no top border. Modal header border is a
  faint white.
* Settings, Changelog, and Tasks pages flattened. Bootstrap card chrome
  removed where it added no information.
* Login page rewritten in `login/login.css`. The React bundle CSS is not
  loaded on `/login`, so login styling is in its own stylesheet.
* Feed keyboard map: arrow keys scroll vertically, left/right seek &plusmn;10s,
  `j`/`k` scroll, `h`/`l` seek, `m` toggles mute.
* The current scene id is persisted across page reloads. If the saved id
  references a deleted scene, it is cleared automatically.
* All theme rules ship in the binary. No separate `custom.css` is required.
* Automatic update check is disabled.

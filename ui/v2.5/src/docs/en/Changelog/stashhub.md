### stashhub v1.4.44

* Framed in another app, stashhub shows a bottom bar (back, forward, skip 10 seconds, mute, picture in picture, NEW, like) and a close under the Feed pill.
* Feed: NEW filter shows videos added in the last 60 days or played at most twice, shuffled. Turn on under Feed Algorithm, it takes the funscript filter's place.
* Login: the box is centred on phones, with no scrollbar.
* Feed: fix captions showing twice on iPhone.
* Scene player drives Intiface toys from the funscript, like the feed.
* Settings: Maximum strength caps vibrating and oscillating toys.
* Feed: buffering no longer restarts the download, which could leave a scene reloading forever.
* Feed: the next video no longer waits 5-20 seconds behind paused ones.
* Feed poster is the scene's first frame, so the picture no longer jumps when playback starts.
* Tasks: new Feed posters option generates those stills.
* Fast mode downloads upcoming feed scenes to the device, one at a time, oldest removed first.
* Settings: Videos to download ahead under Fast mode, 6 by default.
* Feed cache works in browsers without service workers, such as DuckDuckGo on iOS.
* Feed cache was blocked by the security policy, now allowed.
* Settings: Clear cached videos button under Fast mode.
* Feed: only the playing video downloads freely, so a neighbour can no longer saturate the connection.
* Feed: poster clears the moment playback starts, no more pale seams at the corners.
* Feed algorithm: ranked sources rotate which slice they draw from, so the same scenes stop recurring.
* Feed algorithm: new Unwatched source, newest first, with a play-time range under Advanced.
* Feed: the browser tab is named after the scene playing, and follows arrow-key navigation.
* Feed: F toggles fullscreen, Escape leaves it.
* Feed: the fullscreen button now gives an immersive view, video edge to edge with a minimal overlay and the app chrome hidden. Swipe and tap unchanged.
* Feed: picture-in-picture and native player fullscreen buttons, shown in immersive mode. Native fullscreen was previously reachable only by double-click, so not at all on a touch device.
* Feed: immersive mode hides the side and top bars, and its controls fade out, returning on a tap.
* Feed: pinch to zoom the picture, drag to pan while zoomed, release near fit to snap back.
* Feed: entering or leaving fullscreen realigns the current video, so the next one no longer peeks in.
* Feed: the skip button is hidden on mobile, where a swipe already does it.
* Feed: the fullscreen toggle keeps its place when turned on, the extra controls appear above it.
* Feed: square videos show their whole frame instead of being cropped to the screen.
* Feed: the poster matches the video's fit before metadata arrives, so it no longer looks stretched on load.
* Feed: the scene you are watching is cached too, so seeking inside it no longer waits on the network.
* Feed: a play counts after 5 seconds, and watch time is sent every 3 seconds so it climbs visibly.
* Feed: the skip button is now a delete button, with confirmation.
* Deleting a scene no longer removes its funscript. Subtitles were already left alone.
* Feed: the Delete key opens the delete confirmation for the scene on screen.
* Fast-mode copies and posters are removed when their scene is deleted.
* Feed: the eye winks when a play is counted, and stays accented for the rest of the session.
* Feed: the seek bar is now the scene's loudness envelope.
* Feed: hovering the seek bar lightens everything left of the pointer.
* Feed: fullscreen on a desktop-sized window shows the whole frame instead of cropping to fill.
* Feed: Cmd or Ctrl with plus, minus and zero zooms the video rather than the page.
* Scene view: Open in feed button above the created date.
* Feed: in desktop fullscreen the controls and arrows sit against the picture, not the window edge.
* Feed: desktop fullscreen controls step aside while the picture is zoomed, returning on hover.
* Feed: fullscreen keeps the title at its normal size, and the overlay follows the picture edges.
* Feed: taller waveform, dimmer unplayed section, title and buttons lifted clear of it.
* Feed: our fullscreen stays inside the browser window. The player button still gives real fullscreen.
* Feed: no nav arrows in fullscreen, where arrow keys and swipe already move the feed.
* Feed: in fullscreen the seek bar and title match the picture's width and stay at the bottom.
* Feed: on a mouse or trackpad, one scroll gesture moves exactly one video.
* Feed: no delete button in fullscreen, and the button rail stays inside its own video.
* Feed algorithm: liked scenes are weighted by likes and by how recently they were liked.
* Feed: holding the down key no longer drops you back a dozen videos when older tiles are trimmed.

### stashhub v1.4.43

* Drop upstream contribution templates, CI workflows, test data and unused readme assets.

### stashhub v1.4.42

* Fast mode: streams a pre-generated 720p copy of each scene so the feed starts instantly and never buffers. Off by default, toggle in Settings.
* Feed: per-scene HQ button switches to full quality mid-playback without losing position.
* Fast mode falls back to the normal stream for any scene not yet pre-generated.
* Fast mode applies immediately in the feed, even if the Settings panel was never opened.
* Fast mode: resolution and codec badges describe the copy playing, not the source file.
* Fast mode toggle takes the accent colour while active.
* Feed: prefetch waits for the current video to start, so it no longer competes with it.
* Feed: mobile keeps four videos loaded instead of eight, which stops the phone running hot.
* Update fonts.
* Drop Docker build and publish files, stashhub ships no images.

### stashhub v1.4.41

* Feed CC button now tracks the real generation job: it shows a red retry state when captions genuinely fail, instead of spinning silently.
* Caption jobs from the feed wait for the transcriber to be free instead of being dropped, and failed scenes are retried nightly.
* Server: HTTP timeouts (Read/ReadHeader/Idle) prevent slow clients from leaking goroutines. nginx upstream keepalive pool makes poster-heavy pages skip per-image TCP handshakes.
* Blocked from search engines: robots.txt, noindex/nofollow meta and header on every response, even the login redirect. Added a proper og:image/title/description for link previews.
* Feed: only one video decodes at a time. Neighbours that finished buffering used to start playing too, which exhausted the phone's video decoders and left later tiles black.
* Feed: fewer videos hold a stream at once, and mobile prefetches one ahead instead of three, so the tile you are watching is not starved of bandwidth.
* Feed: the queue no longer grows without limit while scrolling, so long sessions stay as fast as the first minute.
* Checkboxes show their tick again. It was drawn with a pseudo-element on the input, which browsers are not required to render.
* Check rows have proper spacing and no stray indent; the box and its label sit together instead of drifting apart.
* Typing in the tag picker is no longer laggy: every keystroke used to remount the whole dropdown and every selected chip.

### stashhub v1.4.40

* Feed is now endless: when fresh scenes run out it reshuffles the whole library through the same algorithm instead of stopping.
* Feed: upcoming videos preload during fast swipes so the next tile plays instantly; far tiles are torn down to spare the server.
* Feed algorithm: recently-played hide window default lowered from 7 days to 2.
* Feed: swipe works from anywhere on the tile, buttons and progress bar still take their own taps.
* Feed: title, tags and progress bar fade out with the rest of the overlay, and the button column sits higher.
* Feed algorithm: new For You source learns from what you actually watch, matching performers, tags and title words.
* Feed algorithm: weights are sliders now, each showing its live share of the feed, and the shares are what the queue actually draws.
* Settings: algorithm panel reads as prose and stacks properly on phones.
* Settings: Interactive Toys is now its own tab instead of hiding under Feed Algorithm.
* Feed algorithm: scenes you bounce off fast are shown less, hardest for instant skips. The penalty decays, so they return.
* Feed: seeking inside a video is never learned as a skip, and scenes you never reached no longer count either.
* Settings: skip threshold, memory half-life, demotion ceiling and the tag-skip blocker are all tunable under Advanced.

### stashhub v1.4.39

* Feed top bar: new CC and Toy filters, show only captioned scenes or only scenes with a funscript.
* Feed: the URL updates per scene as you swipe, and back/forward step through videos.

### stashhub v1.4.38

* Feed: interactive toys now work with any Intiface Central device (Kiiroo Keon and Powerblow, Lovense, Handy over Bluetooth), alongside the existing Handy cloud sync.
* Settings: new Interactive toys section to enable Intiface, set its address, and connect. The feed auto-connects when the toy toggle is on.
* Feed toy sync drives strokers by position, suction/oscillating toys by stroke speed, and vibrators by intensity, all from the same funscript.
* Feed toy button is now sync-only: dimmed on scenes without a funscript, active by default on scenes with one.

### stashhub v1.4.37

* Feed: Handy interactive sync with visual thrust indicator. A sextoy icon on funscripted scenes toggles device sync; a glowing dot on the video edge moves in real time with the funscript timeline, visible even without a Handy connected.

### stashhub v1.4.36

* Feed: CC on a subless video shows the generating spinner instantly on press, no more dead-looking presses that quietly queued duplicate caption jobs.

### stashhub v1.4.35

* Feed: caption cues are tracked continuously so the CC show/hide toggle applies instantly.

### stashhub v1.4.34

* Feed: video now crossfades in from the poster on play, no more still-frame flash when a clip starts.
* Feed: buffering shows a spinning loader ring (TikTok/Google style) instead of the poster pulse.
* Feed: poster fills the frame (cover) on mobile, matching the video.

### stashhub v1.4.33

* Feed: the playing video now gets bandwidth priority, neighbours prefetch a beat later so playback never stutters.
* Feed: buffer the previous tile too, so arrow/swipe back plays instantly with no rebuffer.
* Feed streaming: nginx passes video straight through, browser range requests drive seeks for smoother scrubbing.
* Scene media (video, posters, previews) now browser-cacheable, so backward seeks and re-scrolls are instant.

### stashhub v1.4.32

* Feed: show the scene poster instead of a black tile before the video decodes.
* Feed: fast-skipping now only loads the tile you land on, ending the black-pause-play thrash.
* Scene player captions: larger (20 px) and lifted clear of the control bar.
* stash app icon hard-cropped with a full iOS/PWA size set (apple-touch, ico, png, svg).

### stashhub v1.4.29

* ScenePlayer captions: fix double background + rounded corners. Single flat 50% bg on the inner box only, matching the feed.

### stashhub v1.4.28

* Favicon recoloured to hub-purple: the 256x256 box rect is hub-purple, inner shape dark for contrast. Originals stashed in public/favicon-backup-orig.
* SQLite page cache 256 MB → 1 GB.

### stashhub v1.4.26

* SQLite: bump page cache to 256 MB, mmap the DB, route temp B-trees to RAM. UI queries are dramatically faster on any library that previously fit in 2 MB of cache.

### stashhub v1.4.25

* Feed caption text bumped to 22 px desktop / 16 px mobile, with more padding to match.

### stashhub v1.4.24

* Feed CC button: SlimSceneData now carries captions so the feed actually knows which scenes have captions instead of showing CC+ on everything.
* Feed arrow/j/k nav: disable scroll-snap during the animation so the slide is visible instead of an instant jump.

### stashhub v1.4.23

* Feed captions rendered in a React overlay so iOS accessibility caption prefs can't override the styling. Flat 50% bg, StashHub Subtitles Bold, real padding.
* StashHub Subtitles @font-face moved into the main bundle so caption fonts load on every route.

### stashhub v1.4.22

* Captions: kill the vtt.js inline #000 on the cue inner div. ::cue is now the single background source.

### stashhub v1.4.21

* Captions: ::cue is the only renderer, video.js wrapper background nulled. Fixes ScenePlayer "black rectangle, no text".

### stashhub v1.4.20

* ScenePlayer caption double background fixed; native ::cue made transparent so only video.js renders.
* Caption padding bumped to 6/14 px. Feed-only ::cue scope so it can't leak into ScenePlayer.
* Diagnostic console.debug in FeedCcButton to surface caption state per render.

### stashhub v1.4.19

* Feed fetchSceneDetails switched to no-cache so caption metadata is always fresh.

### stashhub v1.4.18

* Captions: drop the smudgy text-shadow, drop border-radius, more padding. Single Bold weight reads cleaner.
* Feed: remove cue-reader's track-mode override so captionsOn always wins; captions show in feed reliably.

### stashhub v1.4.17

* Feed: scrub-to-start fixed. Stuck-load recovery now skips while `seeking`, so user seeks don't snap to 0.
* Feed: speech markers. Hub-purple ticks on the progress bar at each VTT cue start.

### stashhub v1.4.16

* Feed CC button: when defensive check finds existing captions, hard-reload the page so the new scene record loads cleanly.

### stashhub v1.4.15

* Captions-appeared listener bypasses Apollo cache so the refetched scene actually carries the new captions.

### stashhub v1.4.14

* Feed video drops `crossOrigin="anonymous"`; `<track>` requests can now send session cookies, captions actually load.

### stashhub v1.4.13

* Revert v1.4.12 feed-active-scene event; per-IO-tick setScenes was breaking pause. Click CC+ to refresh stale captions.

### stashhub v1.4.12

* Feed CC button re-checks captions against the server when the scene becomes active or on click, so generations triggered elsewhere stop showing the stale "+" icon.

### stashhub v1.4.11

* In-app watchdog also kills ffmpegs writing to generated/tmp older than 25 min.
* Stash config: scan_task.scangenerate*:false defaults so manual scans no longer auto-queue Generate.

### stashhub v1.4.10

* Mobile ScenePlayer: hide secondary controls (skip, airplay, chromecast, PiP, playback rate) under 576 px so the fullscreen button stays on-screen.

### stashhub v1.4.9

* Mobile feed: pin overflow-x:hidden on the track so stray-pixel children can't drag a horizontal scrollbar in.

### stashhub v1.4.8

* Feed CC "generate" icon redrawn as the filled CC pill + a clear "+" badge.

### stashhub v1.4.7

* In-app job watchdog: cancels any RUNNING job whose progress hasn't advanced in 15 min. External cron retired.
* Scene cards show a CC badge when scene.captions exist.
* Scene detail page: Generate captions button next to Organized.
* Feed CC button now cycles: no-CC → generating (spinner ring) → captions on/off toggle. Generation runs server-side.

### stashhub v1.4.6

* Arrow up/down and j/k feed nav use a 220 ms ease-out-cubic slide, snappier than browser smooth.

### stashhub v1.4.4

* Pretty feed URLs: /feed/:id reflects the visible scene, updates via replaceState as you scroll.
* Captions: 15 px, Bold + double white-stroke shadow for a chunkier read.

### stashhub v1.4.3

* Caption font: StashHub Subtitles Light/Medium/Bold bundled, cues at 18 px Bold.
* ScenePlayer captions always default-on, prefer user's language else first available.

### stashhub v1.4.2

* Caption styling: 22 px, StashHub Subtitles Medium with `@font-face` slot at /fonts/StashHubSubtitles-Medium.woff2.

### stashhub v1.4.1

* Feed deep link: /?scene=ID jumps that scene to the front of the queue.
* ScenePlayer captions: video.js emulated cues now styled to match feed.

### stashhub v1.4.0

* Captions: feed renders sidecar VTT/SRT, CC button next to mute, ON by default per tab.
* Cue styling: 50% black bg, white text, StashHub Subtitles stack with sane fallbacks.
* Resolution + codec mini-tags after title (1080p, HEVC, Dolby etc), dark bg, slight radius.

### stashhub v1.3.9

* Removed daily wrap card.

### stashhub v1.3.8

* Removed all polling-based video recovery. `onWaiting` retries capped at 3 then waits for native events.

### stashhub v1.3.7

* Reverted v1.3.6 stuck-black branch causing poster-black-poster flicker on long videos.

### stashhub v1.3.6

* Mobile feed: removed the 1 rem horizontal padding around the active
  tile. The video now fills viewport width edge-to-edge. Border radius
  also drops to 0 on mobile so corners hug the edges cleanly.
* Removed the `fetch()`-based stream pre-warm that v1.3.0 added.
  Issuing a parallel Range request to Stash's `/scene/{id}/stream`
  while the `<video>` element was preparing to load the same URL
  occasionally raced Stash's live-transcode session, and aborting the
  pre-warm on scroll-past sometimes cancelled an ffmpeg session the
  `<video>` element was about to depend on. The result: tiles
  occasionally stuck on a black frame. Browser-native
  `preload="auto"` on active + N ahead is doing the job on its own.
* Added a stuck-black recovery branch to the active-video watchdog.
  If the tile the user is looking at is paused with `currentTime = 0`
  and `readyState < 3` for over 3 s, the watchdog forces a `load()`
  and `play()`, so a transient transcode hiccup doesn't permanently
  black out the screen.

### stashhub v1.3.5

* Settings, Feed Algorithm: passive "Saved" pill flashes in the top
  right of the panel each time a setting auto-saves. It's a sticky
  bubble with a green dot and a 1.4 s dwell, just enough to confirm the
  edit landed without dragging attention.
* Added an explicit Save button at the bottom of the panel. Settings
  still auto-save on edit; clicking the button re-pushes everything
  (including the chip defs to `configureUISetting`) and triggers a
  Stash toast for active confirmation.
* Dropped the dashed border on chip island buttons. It used to mark
  strict-mode chips back when boost mode also existed; now that every
  active chip is strict, the dashed style was meaningless and visually
  noisy. All chip buttons share the same glass style; the only state
  change is the hub-purple ring + glow when active.

### stashhub v1.3.4

* Filter chips are now **single-select**. Tapping a chip makes it the
  sole active filter; tapping a different chip switches; tapping the
  active chip clears the filter. The old multi-chip-at-once behaviour
  was confusing.
* Active chips now always behave **strictly**: the feed reroles to only
  scenes carrying any of the chip's tag IDs. The boost vs strict mode
  distinction is gone from the UI (and from the runtime path) since the
  user-facing mental model is "show me this". The chip definition's
  `mode` field defaults to `strict`.
* Reroll on chip toggle preserves the currently visible scene at the
  front of the new queue, so the swap looks seamless instead of clearing
  the feed.
* Settings, Feed Algorithm panel: fixed the broken mobile layout where
  the row title (Hottest, Liked, etc.) was squished to one character
  wide because the chip editor pushed the panel beyond viewport width.
  On viewports under 720 px every setting row now stacks vertically and
  the chip editor's controls flow into one column.
* Daily wrap card now sits above the topright island row (z-index 240
  vs 200) and on viewports under 640 px is pushed down to 60 px from the
  top so it doesn't overlap the bell pill horizontally.

### stashhub v1.3.3

* Filter chip icon set replaced with tightened white-fill SVGs (tongue,
  boobs, sex, blowjob) supplied by the user. Each icon now declares its
  own `viewBox` so the source artwork at 100x100 or 90x90 stays usable
  without forcing everything onto a 24x24 grid. Render size bumped from
  18 to 20 px so the new artwork fills the chip button properly.
* Generic icon set (lips, peach, drop, flame, heart, star, sparkle, eye,
  bolt) kept as a fallback selection in the settings dropdown.
* Topright bar and chip island restyled to read as proper frosted glass.
  Blur raised from 18 px to 32 px, background opacity dropped from 0.6 to
  0.28, saturation boost from 170 % to 190 %, plus a 1 px inset top
  highlight so each pill catches light along its top edge. Same treatment
  applied to chip buttons: subtle top-light vertical gradient at rest, a
  brighter gradient on hover with a 1 px lift, hub-purple gradient on
  active.

### stashhub v1.3.2

* Filter chips are now a separate floating "island" pill in the top-right,
  positioned to the left of the notification bell. They're no longer
  rendered on top of the video in the feed action stack.
* Chips render built-in white SVG icons instead of free-text emojis. The
  icon set ships with the build (tongue, lips, breast, peach, drop,
  flame, heart, star, sparkle, eye, bolt, thrust). The Settings panel's
  emoji input is replaced with an icon-name dropdown plus a live preview.
  The `emoji` field on existing chips is still read for backwards
  compatibility but new chips use `iconName`.
* Toggling a chip in the island weights the feed toward that chip's
  tags. The feed listens for `stashhub:feed-chip-active-changed` and
  rebuilds the queue when the active set changes. Boost mode adds the
  union as a weighted bucket, strict mode wraps every bucket in an
  AND filter, same semantics as v1.3.0.

### stashhub v1.3.1

* Filter chip *defs* (label, emoji, tag IDs, weight, mode) now persist in
  Stash's server-side `ui` config under `stashhub.filterChips` via the
  `configureUISetting` mutation, instead of `localStorage`. They survive
  cache clears and follow the account across browsers and devices. Active
  chip state (which chips are toggled on right now) stays per-device in
  `localStorage feed.filterChips.active`, treating "which lens am I using
  this minute" as runtime UI state rather than a saved preference.
* `SettingsAlgorithmPanel` reads the server copy on mount, merges it into
  local state, then mirrors any chip edit back to the server. The
  algorithm's synchronous read path still goes through
  `localStorage algorithm.settings`, kept in sync from the server response.

### stashhub v1.3.0

* New **filter chips** in the feed. Three configurable quick filters,
  defined under Settings, Feed Algorithm, Advanced. Each chip stores an
  emoji, a label, a list of tag IDs, a weight, and a mode (Boost or
  Strict). Empty slots are hidden, so the public defaults ship as three
  blank rows and only appear in the feed once you fill them in.
  * Boost mode adds the chip's tag union as a new "Chip boost" bucket in
    the queue at the chip's weight. Tap to widen toward those tags.
  * Strict mode wraps every bucket's `findScenes` call in
    `AND { tags: includes [...] }` so the queue only contains scenes
    carrying at least one of the chip's tags. Strict overrides Boost
    when both are active at once.
  * Active chip state is per-device in `localStorage feed.filterChips.active`.
    Toggling a chip rebuilds the queue immediately.
* Arrow keys on desktop now show the same centred pulse chip that
  edge-tap shows. ArrowLeft / `h` keeps rewinding 10s, ArrowRight / `l`
  keeps advancing 10s. The Feed dispatches a `feed-pulse-trigger` event
  on the active item which FeedItem mirrors into pulse state.
* **Buffering pre-warm.** On every scroll into a new active tile, the
  feed kicks off `fetch(streamUrl, { headers: { Range: 'bytes=0-524287' } })`
  for the next two or three tiles ahead. That forces Stash to start the
  live transcode and warms the CIFS source-file read before the user
  scrolls there, cutting time-to-first-frame on cold tiles dramatically.
  In-flight requests are aborted when the user scrolls past so we don't
  keep transcoding scenes that have left the window.
* **Bigger preload window on desktop.** On pointer devices, the
  aggressive `preload="auto"` window goes from 2 ahead to 3 ahead.
  Mobile stays at 2 to avoid cellular bandwidth burn.
* **Streaming transcode capped at 720p**, server-side. `config.yml` now
  carries `max_streaming_transcode_size: STANDARD_HD`. Live transcode
  produces bytes 2-3x faster at 720p than at 1080p, with no visible
  loss on phones. This is the single biggest contributor to
  buffer-less feel.
* **Transcode cache moved to the storagebox.** The local SSD was
  fighting the DB for space; transcodes now live on the storagebox CIFS
  mount via a symlink, cap raised from 4 GB to 30 GB. Prune cron
  simplified, the SSD emergency-mode is no longer needed because the DB
  has the SSD to itself again.
* **Revert: adaptive poster accent removed.** The v1.2.0 feature that
  sampled the dominant poster colour and wrote it onto `.feed-item` as
  `--feed-scene-accent` is gone. The action button borders, hover glow,
  filter chip "active" ring, and progress bar gradient all go back to
  hub-purple (or a neutral white-alpha border on the action buttons).
  Sampled colours misread on washed or letterboxed posters and ended up
  changing more of the chrome than intended.

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

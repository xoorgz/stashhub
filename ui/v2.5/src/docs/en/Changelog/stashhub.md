### stashhub

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

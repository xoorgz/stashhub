import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import {
  loadAlgorithmSettings,
  AlgorithmSettings,
} from "../Settings/SettingsAlgorithmPanel";

const client = getClient();

/**
 * Buckets, draw order:
 *   hottest     scenes tagged with the configured tag
 *   liked       scenes with like_count > 0, ordered by like_count desc
 *   topOCount   scenes with o_counter >= threshold, ordered by o_counter desc
 *   topRated    scenes with rating100 >= threshold
 *   stale       scenes with last_played_at older than the configured window
 *   random      unfiltered random
 */

export interface BuildQueueOpts {
  targetCount?: number;
  exclude?: Set<string>;
}

let cachedHottestTagId: { name: string; id: string | null } | null = null;

async function getHottestTagId(tagName: string): Promise<string | null> {
  if (cachedHottestTagId && cachedHottestTagId.name === tagName) {
    return cachedHottestTagId.id;
  }
  try {
    const result = await client.query<
      GQL.FindTagsQuery,
      GQL.FindTagsQueryVariables
    >({
      query: GQL.FindTagsDocument,
      variables: {
        filter: { per_page: 1, page: 1 },
        tag_filter: {
          name: { value: tagName, modifier: GQL.CriterionModifier.Equals },
        },
      },
    });
    const id = result.data.findTags.tags[0]?.id ?? null;
    cachedHottestTagId = { name: tagName, id };
    return id;
  } catch {
    cachedHottestTagId = { name: tagName, id: null };
    return null;
  }
}

interface BucketOpts {
  filter: GQL.FindFilterType;
  sceneFilter: GQL.SceneFilterType;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn("[feed] request timed out after", ms, "ms");
      resolve(fallback);
    }, ms);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        console.warn("[feed] request failed", e);
        resolve(fallback);
      }
    );
  });
}

async function fetchBucket(opts: BucketOpts): Promise<string[]> {
  return withTimeout(
    client
      .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
        query: GQL.FindScenesDocument,
        variables: { filter: opts.filter, scene_filter: opts.sceneFilter },
      })
      .then((r) => r.data.findScenes.scenes.map((s) => s.id))
      .catch((e) => {
        console.warn("[feed] bucket fetch failed", e);
        return [] as string[];
      }),
    30_000,
    [] as string[]
  );
}

interface BucketSpec {
  name: string;
  weight: number;
  ids: string[];
}

export async function buildQueue(opts: BuildQueueOpts = {}): Promise<string[]> {
  const targetCount = opts.targetCount ?? 30;
  const exclude = new Set(opts.exclude ?? []);
  const settings = loadAlgorithmSettings();

  const seed = `random_${Math.floor(Math.random() * 1e9)}`;
  const over = 3; // over-fetch so post-exclude there's still material

  // Filter chips: an active chip restricts the queue to scenes carrying
  // any of its tag IDs. The user's mental model is "show me tongue stuff"
  // — boost-weighted mode where unrelated scenes still appeared was
  // confusing. So active chips always behave strictly: every bucket's
  // findScenes call gets wrapped in AND { tags: includes union }. With
  // single-select in the UI there's at most one active chip's tag list.
  let strictTagIds: string[] = [];
  try {
    const rawActive = localStorage.getItem("feed.filterChips.active");
    const active: number[] = rawActive ? JSON.parse(rawActive) : [];
    if (Array.isArray(active) && active.length > 0) {
      const union = new Set<string>();
      for (const idx of active) {
        const chip = settings.filterChips?.[idx];
        if (!chip || !chip.tagIds || chip.tagIds.length === 0) continue;
        for (const id of chip.tagIds) union.add(id);
      }
      strictTagIds = Array.from(union);
    }
  } catch {
    /* ignore */
  }
  const boostTagIds: string[] = [];
  const boostWeight = 0;

  // Wrap a bucket's sceneFilter in the strict-chip tag constraint, if any.
  // Uses AND so the bucket's own tag filter (hottest, watched, favored)
  // composes correctly instead of clobbering.
  const withStrict = (sf: GQL.SceneFilterType): GQL.SceneFilterType => {
    if (strictTagIds.length === 0) return sf;
    return {
      ...sf,
      AND: {
        ...(sf.AND ?? {}),
        tags: {
          value: strictTagIds,
          modifier: GQL.CriterionModifier.Includes,
        },
      },
    };
  };
  // Wrap the module-level fetchBucket so every bucket below picks up the
  // strict constraint without touching their call sites individually.
  const fetchBucketStrict = (opts: BucketOpts) =>
    fetchBucket({ ...opts, sceneFilter: withStrict(opts.sceneFilter) });

  // Recently-played exclude: fetch IDs of scenes whose last_played_at is
  // within the configured window and add them to the exclude set. Done as a
  // separate query rather than per-bucket filters because GQL Int/Time filters
  // don't compose with OR and we want to keep never-played scenes (NULL).
  if (
    settings.excludeRecentlyPlayed &&
    settings.excludeRecentlyPlayedDays > 0
  ) {
    const cutoff = new Date(
      Date.now() - settings.excludeRecentlyPlayedDays * 86400_000
    )
      .toISOString()
      .slice(0, 10);
    const recent = await fetchBucket({
      filter: { per_page: 1000, page: 1 },
      sceneFilter: {
        last_played_at: {
          value: cutoff,
          modifier: GQL.CriterionModifier.GreaterThan,
        },
      },
    });
    for (const id of recent) exclude.add(id);
    console.info(
      "[feed] excluding",
      recent.length,
      "recently played (last",
      settings.excludeRecentlyPlayedDays,
      "d)"
    );
  }

  // Skip-learning: tags the user has dismissed under SKIP_THRESHOLD_SEC of
  // playback accumulate counts in localStorage feed.skips.tags. Take the
  // top N tags by count, fetch scenes that have those tags, add to the
  // exclude set so they never enter the queue. Decay on read keeps this
  // from poisoning forever, the storage layer drops entries older than 30d.
  const SKIPPED_TAGS_KEY = "feed.skips.tags";
  const SKIP_TAG_TOP_N = 10;
  // A tag needs at least this many skips before it's used to filter,
  // otherwise a single mis-swipe blocks an entire tag.
  const SKIP_TAG_MIN_COUNT = 3;
  type SkippedTagEntry = { count: number; lastAt: number };
  let topSkipTagIds: string[] = [];
  try {
    const raw = localStorage.getItem(SKIPPED_TAGS_KEY);
    if (raw) {
      const map = JSON.parse(raw) as Record<string, SkippedTagEntry>;
      const entries = Object.entries(map)
        .filter(([, e]) => e && e.count >= SKIP_TAG_MIN_COUNT)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, SKIP_TAG_TOP_N)
        .map(([id]) => id);
      topSkipTagIds = entries;
    }
  } catch {
    /* ignore */
  }
  if (topSkipTagIds.length > 0) {
    const skippy = await fetchBucket({
      filter: { per_page: 1000, page: 1 },
      sceneFilter: {
        tags: {
          value: topSkipTagIds,
          modifier: GQL.CriterionModifier.Includes,
        },
      },
    });
    for (const id of skippy) exclude.add(id);
    console.info(
      "[feed] skip-learning excluded",
      skippy.length,
      "scenes carrying any of",
      topSkipTagIds.length,
      "high-skip tags"
    );
  }

  const fetches: Array<Promise<BucketSpec | null>> = [];

  // Hottest. Prefer tag id; fall back to name lookup for older configs.
  if (settings.hottestEnabled && settings.hottestWeight > 0) {
    fetches.push(
      (async () => {
        const tagId =
          settings.hottestTagId || (await getHottestTagId(settings.hottestTagName));
        if (!tagId) return { name: "hottest", weight: settings.hottestWeight, ids: [] };
        const perPage = Math.max(5, Math.ceil(targetCount * 0.6 * over));
        const ids = await fetchBucketStrict({
          filter: { per_page: perPage, page: 1, sort: seed },
          sceneFilter: {
            organized: true,
            tags: {
              value: [tagId],
              modifier: GQL.CriterionModifier.IncludesAll,
            },
          },
        });
        return { name: "hottest", weight: settings.hottestWeight, ids };
      })()
    );
  }

  // Liked. Fetch top N by like_count desc, then shuffle client-side since
  // a single sort key cannot combine ordering and randomization.
  if (settings.likedEnabled && settings.likedWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
        const ids = await fetchBucketStrict({
          filter: {
            per_page: perPage,
            page: 1,
            sort: "like_count",
            direction: GQL.SortDirectionEnum.Desc,
          },
          sceneFilter: {},
        });
        // Fisher-Yates shuffle on the descending-by-likes window.
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        return { name: "liked", weight: settings.likedWeight, ids };
      })()
    );
  }

  // Top Watched. Scenes whose accumulated play_duration is highest. The user
  // spending real time on a scene is the strongest implicit "I like this"
  // signal we have. Filtered by min seconds so 2-second mis-taps don't poison
  // the ranking.
  if (settings.topWatchedEnabled && settings.topWatchedWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = Math.max(5, Math.ceil(targetCount * 0.5 * over));
        const ids = await fetchBucketStrict({
          filter: {
            per_page: perPage,
            page: 1,
            sort: "play_duration",
            direction: GQL.SortDirectionEnum.Desc,
          },
          sceneFilter: {
            play_duration: {
              value: settings.topWatchedMinSec,
              value2: 999999,
              modifier: GQL.CriterionModifier.Between,
            },
          },
        });
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        return { name: "topWatched", weight: settings.topWatchedWeight, ids };
      })()
    );
  }

  // Watched Tags. Look at the user's top-watched scenes, aggregate
  // play_duration by tag, pick the top tags, then pull random scenes that have
  // any of those tags. The "what categories do you actually spend time on"
  // signal, uses your real behaviour rather than what you tagged as Favored.
  if (settings.watchedTagsEnabled && settings.watchedTagsWeight > 0) {
    fetches.push(
      (async () => {
        const lookback = Math.max(5, settings.watchedTagsLookback);
        const sampleScenes = await client
          .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
            query: GQL.FindScenesDocument,
            variables: {
              filter: {
                per_page: lookback,
                page: 1,
                sort: "play_duration",
                direction: GQL.SortDirectionEnum.Desc,
              },
              scene_filter: {
                play_duration: {
                  value: 1,
                  value2: 999999,
                  modifier: GQL.CriterionModifier.Between,
                },
              },
            },
          })
          .then((r) => r.data.findScenes.scenes)
          .catch(() => [] as GQL.SlimSceneDataFragment[]);

        // Sum play_duration by tag id. Tag's score is the weighted sum.
        const tagScore = new Map<string, number>();
        for (const sc of sampleScenes) {
          const dur = sc.play_duration ?? 0;
          if (!dur) continue;
          for (const t of sc.tags ?? []) {
            tagScore.set(t.id, (tagScore.get(t.id) ?? 0) + dur);
          }
        }
        if (tagScore.size === 0) {
          return { name: "watchedTags", weight: settings.watchedTagsWeight, ids: [] };
        }
        const topTagIds = Array.from(tagScore.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([id]) => id);

        const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
        const ids = await fetchBucketStrict({
          filter: { per_page: perPage, page: 1, sort: seed },
          sceneFilter: {
            tags: {
              value: topTagIds,
              modifier: GQL.CriterionModifier.Includes,
            },
          },
        });
        return { name: "watchedTags", weight: settings.watchedTagsWeight, ids };
      })()
    );
  }

  // Favored Tags. Random scenes that have any tag in the user-curated
  // favoredTagIds list. Configured under Settings → Feed Algorithm → Advanced
  // → Favored Tags. List intentionally empty by default so nothing kink- or
  // taste-specific ships in the repo.
  if (
    settings.favoredTagsEnabled &&
    settings.favoredTagsWeight > 0 &&
    settings.favoredTagIds.length > 0
  ) {
    fetches.push(
      (async () => {
        const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
        const ids = await fetchBucketStrict({
          filter: { per_page: perPage, page: 1, sort: seed },
          sceneFilter: {
            tags: {
              value: settings.favoredTagIds,
              modifier: GQL.CriterionModifier.Includes,
            },
          },
        });
        return { name: "favoredTags", weight: settings.favoredTagsWeight, ids };
      })()
    );
  }

  // Top O-Count. Fetch top N by o_counter desc among scenes that meet the
  // minimum, then shuffle.
  if (settings.topOCountEnabled && settings.topOCountWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
        const ids = await fetchBucketStrict({
          filter: {
            per_page: perPage,
            page: 1,
            sort: "o_counter",
            direction: GQL.SortDirectionEnum.Desc,
          },
          sceneFilter: {
            o_counter: {
              value: settings.topOCountMin,
              value2: 99999,
              modifier: GQL.CriterionModifier.Between,
            },
          },
        });
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        return { name: "topOCount", weight: settings.topOCountWeight, ids };
      })()
    );
  }

  // Top rated
  if (settings.topRatedEnabled && settings.topRatedWeight > 0) {
    const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
    fetches.push(
      fetchBucketStrict({
        filter: { per_page: perPage, page: 1, sort: seed },
        sceneFilter: {
          organized: true,
          rating100: {
            value: settings.topRatingMin,
            value2: 100,
            modifier: GQL.CriterionModifier.Between,
          },
        },
      }).then((ids) => ({ name: "topRated", weight: settings.topRatedWeight, ids }))
    );
  }

  // Stale: last_played_at older than the configured window.
  if (settings.staleEnabled && settings.staleWeight > 0) {
    const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
    const cutoff = new Date(
      Date.now() - settings.staleMinDays * 86400_000
    )
      .toISOString()
      .slice(0, 10);
    fetches.push(
      fetchBucketStrict({
        filter: { per_page: perPage, page: 1, sort: seed },
        sceneFilter: {
          organized: true,
          last_played_at: {
            value: cutoff,
            modifier: GQL.CriterionModifier.LessThan,
          },
        },
      }).then((ids) => ({ name: "stale", weight: settings.staleWeight, ids }))
    );
  }

  // Random.
  if (settings.randomWeight > 0) {
    const perPage = Math.max(5, Math.ceil(targetCount * 0.3 * over));
    fetches.push(
      fetchBucketStrict({
        filter: { per_page: perPage, page: 1, sort: seed },
        sceneFilter: { organized: true },
      }).then((ids) => ({ name: "random", weight: settings.randomWeight, ids }))
    );
  }

  // Chip boost: scenes carrying any of the union of active boost-chip tags.
  // Note this skips withStrict (boostTagIds is empty whenever a strict chip
  // is active, so the two modes can't both contribute at once).
  if (boostTagIds.length > 0 && boostWeight > 0) {
    const perPage = Math.max(5, Math.ceil(targetCount * 0.5 * over));
    fetches.push(
      fetchBucket({
        filter: { per_page: perPage, page: 1, sort: seed },
        sceneFilter: {
          tags: {
            value: boostTagIds,
            modifier: GQL.CriterionModifier.Includes,
          },
        },
      }).then((ids) => ({ name: "chipBoost", weight: boostWeight, ids }))
    );
  }

  const settled = await Promise.all(fetches);
  const buckets: BucketSpec[] = settled
    .filter((b): b is BucketSpec => b !== null && b.ids.length > 0)
    .map((b) => ({ ...b, ids: b.ids.filter((id) => !exclude.has(id)) }))
    .filter((b) => b.ids.length > 0);

  console.info(
    "[feed] buckets:",
    buckets.map((b) => `${b.name}(w=${b.weight},n=${b.ids.length})`).join(", ") || "none"
  );

  // Weighted draw without replacement.
  const out: string[] = [];
  const seen = new Set<string>();
  while (out.length < targetCount && buckets.some((b) => b.ids.length)) {
    const totalW = buckets.reduce(
      (s, b) => s + (b.ids.length ? b.weight : 0),
      0
    );
    if (!totalW) break;
    let r = Math.random() * totalW;
    for (const b of buckets) {
      if (!b.ids.length) continue;
      r -= b.weight;
      if (r <= 0) {
        const id = b.ids.shift();
        if (id && !seen.has(id)) {
          out.push(id);
          seen.add(id);
        }
        break;
      }
    }
  }

  // Fallback: unfiltered random.
  if (out.length === 0) {
    console.warn(
      "[feed] all buckets empty, falling back to unfiltered random"
    );
    const fallback = await fetchBucketStrict({
      filter: { per_page: targetCount, page: 1, sort: seed },
      sceneFilter: {},
    });
    for (const id of fallback) {
      if (!seen.has(id)) {
        out.push(id);
        seen.add(id);
        if (out.length >= targetCount) break;
      }
    }
  }

  console.info("[feed] buildQueue", out.length, "ids");
  return out;
}

export async function fetchSceneDetails(
  ids: string[]
): Promise<GQL.SceneDataFragment[]> {
  const numericIds = ids
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!numericIds.length) return [];
  return withTimeout(
    client
      .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
        query: GQL.FindScenesDocument,
        variables: {
          filter: { per_page: numericIds.length, page: 1 },
          scene_filter: {},
          scene_ids: numericIds,
        },
      })
      .then((result) => {
        const order = new Map(ids.map((id, i) => [id, i]));
        return [...result.data.findScenes.scenes].sort(
          (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
        );
      })
      .catch((e) => {
        console.warn("[feed] detail fetch failed", e);
        return [] as GQL.SceneDataFragment[];
      }),
    30_000,
    [] as GQL.SceneDataFragment[]
  );
}

// Re-export so existing imports keep working
export type { AlgorithmSettings };

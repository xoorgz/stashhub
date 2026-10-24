import * as GQL from "src/core/generated-graphql";
import { getClient } from "src/core/StashService";
import { baseURL } from "src/core/createClient";
import {
  loadAlgorithmSettings,
  AlgorithmSettings,
} from "../Settings/SettingsAlgorithmPanel";

const client = getClient();

/** Buckets, in draw order: hottest, liked, topOCount, topRated, stale, random. */

export interface BuildQueueOpts {
  targetCount?: number;
  exclude?: Set<string>;
  // Endless-feed recycle pass: skip the exclusions that deliberately shrink
  // the candidate pool (recently-played, skip-learning) so the whole library
  // is reshuffled once fresh material runs out. Buckets still apply.
  recycle?: boolean;
}

// NEW chip: added within NEW_DAYS, or played at most NEW_MAX_PLAYS times.
const NEW_DAYS = 60;
const NEW_MAX_PLAYS = 2;

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

// Library size, fetched once. Ranked buckets need it to walk their whole
// ranking instead of stopping at a few hardcoded pages. The promise is cached
// so the first batch of concurrent ranked fetches shares one query.
let totalCountPromise: Promise<number> | null = null;
function totalSceneCount(): Promise<number> {
  if (!totalCountPromise) {
    totalCountPromise = client
      .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
        query: GQL.FindScenesDocument,
        variables: { filter: { per_page: 1, page: 1 }, scene_filter: {} },
      })
      .then((r) => r.data.findScenes.count)
      .catch(() => 0);
  }
  return totalCountPromise;
}

// Rows a bucket's own filter matches. Paging against the library total instead
// walked straight off the end of every filtered bucket: "liked" holds ~500 of
// 2676 scenes, "top O-count" ~180, so the computed page exceeded their last
// real page early on, came back empty, and fell back to page 1 forever. That
// is what pinned the feed to the same few hundred scenes.
const bucketCountCache = new Map<string, Promise<number>>();
function bucketCount(sceneFilter: GQL.SceneFilterType): Promise<number> {
  const key = JSON.stringify(sceneFilter);
  let hit = bucketCountCache.get(key);
  if (!hit) {
    hit = client
      .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
        query: GQL.FindScenesDocument,
        variables: { filter: { per_page: 1, page: 1 }, scene_filter: sceneFilter },
      })
      .then((r) => r.data.findScenes.count)
      .catch(() => 0);
    bucketCountCache.set(key, hit);
  }
  return hit;
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

/** Same query as fetchBucket, but keeps the whole scene so we can score it. */
async function fetchSlim(
  opts: BucketOpts
): Promise<GQL.SlimSceneDataFragment[]> {
  return withTimeout(
    client
      .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
        query: GQL.FindScenesDocument,
        variables: { filter: opts.filter, scene_filter: opts.sceneFilter },
      })
      .then((r) => r.data.findScenes.scenes as GQL.SlimSceneDataFragment[])
      .catch((e) => {
        console.warn("[feed] slim fetch failed", e);
        return [] as GQL.SlimSceneDataFragment[];
      }),
    30_000,
    [] as GQL.SlimSceneDataFragment[]
  );
}

const TITLE_STOPWORDS = new Set([
  "with", "from", "this", "that", "your", "have", "when", "then", "they",
  "them", "want", "wants", "gets", "gives", "goes", "into", "over", "onto",
  "part", "scene", "video", "full", "free", "porn", "hd", "and", "the", "for",
  "her", "his", "you", "she", "him", "not", "but", "all", "get", "got",
]);

/** Title words worth matching on. Bracketed tag suffixes are stripped: a lot of
 *  the library carries legacy "-[tag, tag]" filenames and they would otherwise
 *  drown out the real words. */
function titleWords(title?: string | null): string[] {
  if (!title) return [];
  return Array.from(
    new Set(
      title
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, " ")
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w))
    )
  );
}

function topKeys(m: Map<string, number>, n: number): string[] {
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

const SCENE_SKIPS_KEY = "feed.skips.scenes";

type SceneSkipEntry = { c: number; m: number; t: number };

/** Returns sceneId -> probability of dropping a draw, 0 to skipMaxSuppress.
 *  Severity follows the fewest seconds ever watched and decays on a half-life. */
function makeSkipDemotion(
  settings: AlgorithmSettings,
  recycle?: boolean
): (id: string) => number {
  if (recycle || !settings.skipDemoteEnabled) return () => 0;

  let map: Record<string, SceneSkipEntry>;
  try {
    map = JSON.parse(localStorage.getItem(SCENE_SKIPS_KEY) || "{}");
  } catch {
    return () => 0;
  }

  const now = Date.now();
  const halfLifeMs = Math.max(1, settings.skipHalfLifeDays) * 86_400_000;
  const max = Math.min(0.95, Math.max(0, settings.skipMaxSuppress / 100));

  return (id: string) => {
    const e = map[id];
    if (!e || !e.c) return 0;
    const threshold = Math.max(1, settings.skipThresholdSec);
    const severity = Math.min(
      1,
      Math.max(0.05, 1 - Math.min(e.m, threshold) / threshold)
    );
    const strength = 1 - Math.exp(-severity * e.c);
    const decay = Math.pow(0.5, (now - e.t) / halfLifeMs);
    return max * strength * decay;
  };
}

// A fixed sort key returns the same head of the ranking every session, so
// over-fetch a wider band and sample from it to keep the selection changing.
const RANKED_POOL_FACTOR = 6;
const RANKED_POOL_MAX = 200;

function rankedPool(perPage: number): number {
  return Math.min(RANKED_POOL_MAX, Math.max(perPage, perPage * RANKED_POOL_FACTOR));
}

// A fixed sort key returns the same head every time, so page 1 means the same
// scenes every session however hard they are shuffled: order changes, the cast
// does not. topWatched made it worse by feeding itself, since watching a scene
// raises its play_duration and pins it near the top. The page now walks the
// ranking as the session progresses; this is only the floor when the library
// size cannot be read.
const RANKED_PAGES = 5;

// What a recent like adds on top of the all-time count. At 1, three likes in
// the past week roughly quadruple a scene's pull against its count alone.
const LIKE_RECENCY_BOOST = 1;

/** [likes, recency] per liked scene id. Empty on failure, which callers treat
 *  as "no scores" and fall back to the plain ranking. */
async function fetchLikeScores(): Promise<Map<string, [number, number]>> {
  const body = await withTimeout(
    fetch(`${baseURL}scene/like-scores`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})),
    15_000,
    {}
  );
  return new Map(Object.entries(body as Record<string, [number, number]>));
}

/** Weighted random order (Efraimidis-Spirakis). Every item appears once; the
 *  chance of landing early is proportional to its weight. */
function weightedShuffle<T>(items: T[], weight: (item: T) => number): T[] {
  return items
    .map((item) => ({
      item,
      key: Math.pow(Math.random(), 1 / Math.max(weight(item), 1e-6)),
    }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface BucketSpec {
  name: string;
  weight: number;
  ids: string[];
}

export async function buildQueue(opts: BuildQueueOpts = {}): Promise<string[]> {
  const targetCount = opts.targetCount ?? 30;
  const exclude = new Set(opts.exclude ?? []);
  const recycle = opts.recycle ?? false;
  const settings = loadAlgorithmSettings();

  const seed = `random_${Math.floor(Math.random() * 1e9)}`;
  const over = 3; // over-fetch so post-exclude there's still material

  // An active chip reads as "only show me this", so it restricts strictly:
  // every bucket's findScenes call is wrapped in AND { tags: includes union }.
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

  // Built-in attribute filters from the top bar: CC restricts to scenes with
  // captions, Toy to scenes with a funscript (interactive). Independent of the
  // tag chips and of each other.
  let ccActive = false;
  let toyActive = false;
  let newActive = false;
  try {
    ccActive = localStorage.getItem("feed.filter.cc") === "1";
    toyActive = localStorage.getItem("feed.filter.toy") === "1";
    newActive = localStorage.getItem("feed.filter.new") === "1";
  } catch {
    /* ignore */
  }

  // Wrap a bucket's sceneFilter in the active constraints. Tag chips go through
  // AND so the bucket's own tag filter composes; interactive/captions are
  // unique top-level fields and just set directly.
  const withStrict = (sf: GQL.SceneFilterType): GQL.SceneFilterType => {
    let out: GQL.SceneFilterType = { ...sf };
    if (toyActive) out.interactive = true;
    if (ccActive)
      out.captions = { value: "", modifier: GQL.CriterionModifier.NotNull };
    if (strictTagIds.length > 0) {
      out = {
        ...out,
        AND: {
          ...(out.AND ?? {}),
          tags: {
            value: strictTagIds,
            modifier: GQL.CriterionModifier.Includes,
          },
        },
      };
    }
    if (newActive) {
      // One sub-filter per level in stash, so the OR group nests under any tag AND.
      const recent: GQL.SceneFilterType = {
        created_at: {
          value: new Date(Date.now() - NEW_DAYS * 86400_000).toISOString(),
          modifier: GQL.CriterionModifier.GreaterThan,
        },
        OR: {
          play_count: {
            value: NEW_MAX_PLAYS + 1,
            modifier: GQL.CriterionModifier.LessThan,
          },
        },
      };
      out = { ...out, AND: out.AND ? { ...out.AND, AND: recent } : recent };
    }
    return out;
  };
  // Wrap the module-level fetchBucket so every bucket below picks up the
  // strict constraint without touching their call sites individually.
  const fetchBucketStrict = (opts: BucketOpts) =>
    fetchBucket({ ...opts, sceneFilter: withStrict(opts.sceneFilter) });
  const fetchSlimStrict = (opts: BucketOpts) =>
    fetchSlim({ ...opts, sceneFilter: withStrict(opts.sceneFilter) });

  // Walk a ranked bucket through its whole ranking over a session. Capping at
  // a few pages made the feed re-serve the same few hundred hot scenes and then
  // wrap; exclude grows with every scene seen, so it drives the page deeper
  // until the entire library has been offered. A deep page that runs dry falls
  // back to the head rather than handing back an empty bucket.
  const fetchRanked = async (opts: BucketOpts, perPage: number) => {
    const pool = rankedPool(perPage);
    // Page count comes from the bucket's own rows; how far to walk comes from
    // the library, since progress is "how much have I seen overall".
    const [total, rows] = await Promise.all([
      totalSceneCount(),
      bucketCount(withStrict(opts.sceneFilter)),
    ]);
    const span = rows > 0 ? rows : total;
    const pages = span > 0 ? Math.max(1, Math.ceil(span / pool)) : RANKED_PAGES;
    const progress = total > 0 ? Math.min(1, exclude.size / total) : 0;
    const page = Math.min(pages, 1 + Math.floor(progress * pages));
    const ids = await fetchBucketStrict({
      ...opts,
      filter: { ...opts.filter, per_page: pool, page },
    });
    if (page === 1 || ids.length >= Math.min(perPage, 5)) return ids;
    return fetchBucketStrict({
      ...opts,
      filter: { ...opts.filter, per_page: pool, page: 1 },
    });
  };

  // Fetch each bucket in proportion to the share it should contribute, so a
  // bucket cannot run dry and silently hand its slots to another.
  const activeWeights: number[] = [];
  const countWeight = (on: boolean, weight: number) => {
    if (on && weight > 0) activeWeights.push(weight);
  };
  countWeight(settings.hottestEnabled, settings.hottestWeight);
  countWeight(settings.likedEnabled, settings.likedWeight);
  countWeight(settings.topWatchedEnabled, settings.topWatchedWeight);
  countWeight(settings.topOCountEnabled, settings.topOCountWeight);
  countWeight(settings.watchedTagsEnabled, settings.watchedTagsWeight);
  countWeight(
    settings.favoredTagsEnabled && settings.favoredTagIds.length > 0,
    settings.favoredTagsWeight
  );
  countWeight(settings.affinityEnabled, settings.affinityWeight);
  countWeight(settings.topRatedEnabled, settings.topRatedWeight);
  countWeight(settings.staleEnabled, settings.staleWeight);
  countWeight(true, settings.randomWeight);
  const totalWeight = activeWeights.reduce((a, b) => a + b, 0);
  const pageFor = (weight: number) =>
    Math.max(
      8,
      Math.ceil(targetCount * (totalWeight > 0 ? weight / totalWeight : 0) * over)
    );

  // Recently-played exclude runs as its own query, not a per-bucket filter:
  // GQL Int/Time filters don't compose with OR and NULL must stay eligible.
  if (
    !recycle &&
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

  // Skip-learning: exclude scenes carrying the most-dismissed tags. Entries
  // decay on read so a tag cannot poison the queue forever.
  const SKIPPED_TAGS_KEY = "feed.skips.tags";
  const SKIP_TAG_TOP_N = 10;
  const SKIP_TAG_MIN_COUNT = Math.max(1, settings.tagSkipMinCount);
  type SkippedTagEntry = { count: number; lastAt: number };
  let topSkipTagIds: string[] = [];
  try {
    const raw = settings.tagSkipEnabled
      ? localStorage.getItem(SKIPPED_TAGS_KEY)
      : null;
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
  if (!recycle && topSkipTagIds.length > 0) {
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

  // NEW replaces the buckets: just the matching scenes, shuffled.
  if (newActive) {
    const ids = await fetchBucketStrict({
      filter: { per_page: -1, sort: seed },
      sceneFilter: {},
    });
    return ids.filter((id) => !exclude.has(id)).slice(0, targetCount);
  }

  const fetches: Array<Promise<BucketSpec | null>> = [];

  // Hottest. Prefer tag id; fall back to name lookup for older configs.
  if (settings.hottestEnabled && settings.hottestWeight > 0) {
    fetches.push(
      (async () => {
        const tagId =
          settings.hottestTagId || (await getHottestTagId(settings.hottestTagName));
        if (!tagId) return { name: "hottest", weight: settings.hottestWeight, ids: [] };
        const perPage = pageFor(settings.hottestWeight);
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

  // Liked. Weighted by sqrt(likes), raised for likes given recently, so a
  // scene with 200 likes surfaces more than one with 10 and a fresh favourite
  // more than an old one. The square root keeps a handful of top scenes from
  // taking over the bucket and looping. Drawn from the whole liked pool rather
  // than walking pages by like count, which moved away from the best liked as
  // a session went on.
  if (settings.likedEnabled && settings.likedWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = pageFor(settings.likedWeight);
        const scores = await fetchLikeScores();
        const filtered = strictTagIds.length > 0 || ccActive || toyActive;

        // An active chip or CC/toy filter can only be applied by the server,
        // and a failed score fetch leaves nothing to draw from, so both take
        // the old ranked page and weight whatever it returns.
        const candidates =
          filtered || scores.size === 0
            ? await fetchRanked(
                {
                  filter: {
                    sort: "like_count",
                    direction: GQL.SortDirectionEnum.Desc,
                  },
                  sceneFilter: {
                    like_count: {
                      value: 0,
                      modifier: GQL.CriterionModifier.GreaterThan,
                    },
                  },
                },
                perPage
              )
            : Array.from(scores.keys());

        const ids = weightedShuffle(
          candidates.filter((id) => !exclude.has(id)),
          (id) => {
            const [likes, recency] = scores.get(id) ?? [1, 0];
            return Math.sqrt(Math.max(likes, 1)) * (1 + LIKE_RECENCY_BOOST * recency);
          }
        );
        return {
          name: "liked",
          weight: settings.likedWeight,
          ids: ids.slice(0, perPage * 3),
        };
      })()
    );
  }

  // Top Watched. Highest accumulated play_duration, the strongest implicit
  // signal. A min-seconds floor keeps mis-taps out of the ranking.
  if (settings.topWatchedEnabled && settings.topWatchedWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = pageFor(settings.topWatchedWeight);
        const ids = await fetchRanked(
          {
            filter: {
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
          },
          perPage
        );
        return {
          name: "topWatched",
          weight: settings.topWatchedWeight,
          ids: shuffleInPlace(ids).slice(0, perPage),
        };
      })()
    );
  }

  // Watched Tags. Aggregate play_duration by tag over the top-watched scenes,
  // then pull random scenes with those tags. Behaviour, not curation.
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

        const perPage = pageFor(settings.watchedTagsWeight);
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

  // Favored Tags. Random scenes carrying any curated favoredTagIds tag. Empty
  // by default so nothing taste-specific ships in the repo.
  if (
    settings.favoredTagsEnabled &&
    settings.favoredTagsWeight > 0 &&
    settings.favoredTagIds.length > 0
  ) {
    fetches.push(
      (async () => {
        const perPage = pageFor(settings.favoredTagsWeight);
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

  // Affinity. Profile recently watched scenes by performer, tag and title word,
  // then rank candidates by how much of that profile they hit. Rebuilt each time.
  if (settings.affinityEnabled && settings.affinityWeight > 0) {
    fetches.push(
      (async () => {
        const empty = {
          name: "affinity",
          weight: settings.affinityWeight,
          ids: [] as string[],
        };
        const cutoff = new Date(
          Date.now() - settings.affinityRecentDays * 86400_000
        )
          .toISOString()
          .slice(0, 10);

        // Profile is deliberately NOT strict-filtered: what you watched is what
        // you watched, even if a CC/Toy chip is narrowing the feed right now.
        const recent = await fetchSlim({
          filter: {
            per_page: Math.max(5, settings.affinityLookback),
            page: 1,
            sort: "last_played_at",
            direction: GQL.SortDirectionEnum.Desc,
          },
          sceneFilter: {
            last_played_at: {
              value: cutoff,
              modifier: GQL.CriterionModifier.GreaterThan,
            },
            play_duration: {
              value: settings.affinityMinSec,
              value2: 999999,
              modifier: GQL.CriterionModifier.Between,
            },
          },
        });
        if (!recent.length) return empty;

        // Every signal is weighted by how long you actually watched that scene.
        const perfScore = new Map<string, number>();
        const tagScore = new Map<string, number>();
        const wordScore = new Map<string, number>();
        for (const sc of recent) {
          const secs = Math.max(1, sc.play_duration ?? 1);
          for (const p of sc.performers ?? [])
            perfScore.set(p.id, (perfScore.get(p.id) ?? 0) + secs);
          for (const t of sc.tags ?? [])
            tagScore.set(t.id, (tagScore.get(t.id) ?? 0) + secs);
          for (const word of titleWords(sc.title))
            wordScore.set(word, (wordScore.get(word) ?? 0) + secs);
        }
        const topPerf = topKeys(perfScore, 5);
        const topTags = topKeys(tagScore, 8);
        const topWords = topKeys(wordScore, 4);
        if (!topPerf.length && !topTags.length && !topWords.length) return empty;

        // Candidates DO respect the active chips/filters.
        const pool = Math.max(40, targetCount * 4);
        const queries: Array<Promise<GQL.SlimSceneDataFragment[]>> = [];
        if (topPerf.length) {
          queries.push(
            fetchSlimStrict({
              filter: { per_page: pool, page: 1, sort: seed },
              sceneFilter: {
                performers: {
                  value: topPerf,
                  modifier: GQL.CriterionModifier.Includes,
                },
              },
            })
          );
        }
        if (topTags.length) {
          queries.push(
            fetchSlimStrict({
              filter: { per_page: pool, page: 1, sort: seed },
              sceneFilter: {
                tags: {
                  value: topTags,
                  modifier: GQL.CriterionModifier.Includes,
                },
              },
            })
          );
        }
        for (const word of topWords) {
          queries.push(
            fetchSlimStrict({
              filter: { per_page: Math.ceil(pool / 2), page: 1, sort: seed },
              sceneFilter: {
                title: {
                  value: word,
                  modifier: GQL.CriterionModifier.Includes,
                },
              },
            })
          );
        }

        const profiled = new Set(recent.map((s) => s.id));
        const candidates = new Map<string, GQL.SlimSceneDataFragment>();
        for (const batch of await Promise.all(queries)) {
          for (const sc of batch) {
            if (profiled.has(sc.id)) continue; // don't replay the profile itself
            candidates.set(sc.id, sc);
          }
        }
        if (!candidates.size) return empty;

        // Normalise each signal so one mega-watched performer can't drown out
        // everything else. Performer > tag > title word.
        const norm = (m: Map<string, number>) => {
          const max = Math.max(1, ...Array.from(m.values()));
          return (k: string) => (m.get(k) ?? 0) / max;
        };
        const perfN = norm(perfScore);
        const tagN = norm(tagScore);
        const wordN = norm(wordScore);

        const scored: Array<{ id: string; score: number }> = [];
        for (const sc of Array.from(candidates.values())) {
          let score = 0;
          for (const p of sc.performers ?? []) score += 3 * perfN(p.id);
          for (const t of sc.tags ?? []) score += 1.5 * tagN(t.id);
          for (const word of titleWords(sc.title)) score += wordN(word);
          if (score > 0) scored.push({ id: sc.id, score });
        }
        scored.sort((a, b) => b.score - a.score);
        console.info(
          "[feed] affinity: profiled",
          recent.length,
          "recent scenes ->",
          topPerf.length,
          "performers,",
          topTags.length,
          "tags,",
          topWords.length,
          "words ->",
          scored.length,
          "ranked candidates"
        );
        return { ...empty, ids: scored.map((s) => s.id) };
      })()
    );
  }

  // Top O-Count. Fetch top N by o_counter desc among scenes that meet the
  // minimum, then shuffle.
  if (settings.topOCountEnabled && settings.topOCountWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = pageFor(settings.topOCountWeight);
        const ids = await fetchRanked(
          {
            filter: {
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
          },
          perPage
        );
        return {
          name: "topOCount",
          weight: settings.topOCountWeight,
          ids: shuffleInPlace(ids).slice(0, perPage),
        };
      })()
    );
  }

  // Unwatched. Newest first so fresh additions surface, with the page rotated
  // so it does not keep offering the same newest few. Both bounds at 0 means
  // play_duration is exactly 0, which is every scene never played.
  if (settings.unwatchedEnabled && settings.unwatchedWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = pageFor(settings.unwatchedWeight);
        const min = Math.max(0, settings.unwatchedMinSec ?? 0);
        const max = Math.max(min, settings.unwatchedMaxSec ?? 0);
        const ids = await fetchRanked(
          {
            filter: {
              sort: "created_at",
              direction: GQL.SortDirectionEnum.Desc,
            },
            sceneFilter: {
              play_duration: {
                value: min,
                value2: max,
                modifier: GQL.CriterionModifier.Between,
              },
            },
          },
          perPage
        );
        console.info("[feed] unwatched:", ids.length, `played ${min}-${max}s`);
        return {
          name: "unwatched",
          weight: settings.unwatchedWeight,
          ids: shuffleInPlace(ids).slice(0, perPage),
        };
      })()
    );
  }

  // Top rated
  if (settings.topRatedEnabled && settings.topRatedWeight > 0) {
    const perPage = pageFor(settings.topRatedWeight);
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
    const perPage = pageFor(settings.staleWeight);
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
    const perPage = pageFor(settings.randomWeight);
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

  // Weighted draw without replacement. Buckets overlap heavily, so on a
  // duplicate keep pulling from the same bucket rather than burning the draw.
  const demotion = makeSkipDemotion(settings, recycle);
  let demoted = 0;
  const out: string[] = [];
  const seen = new Set<string>();
  while (out.length < targetCount) {
    const live = buckets.filter((b) => b.ids.length > 0);
    if (!live.length) break;
    const totalW = live.reduce((s, b) => s + b.weight, 0);
    if (totalW <= 0) break;

    let r = Math.random() * totalW;
    let chosen = live[live.length - 1];
    for (const b of live) {
      r -= b.weight;
      if (r <= 0) {
        chosen = b;
        break;
      }
    }

    let picked: string | undefined;
    while (chosen.ids.length) {
      const id = chosen.ids.shift()!;
      if (seen.has(id)) continue;
      // Demote scenes the user bounces off. Probabilistic, not a ban: the
      // scene keeps its place in the pool and simply loses most of its draws.
      if (Math.random() < demotion(id)) {
        demoted++;
        continue;
      }
      picked = id;
      break;
    }
    if (picked) {
      out.push(picked);
      seen.add(picked);
    }
  }
  if (demoted) console.info("[feed] skip-demoted", demoted, "draws");

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

// The FindScenes query returns fewer fields than SceneDataFragment, so the feed
// works off the query's own row type rather than lying about what it has.
export type FeedScene = GQL.FindScenesQuery["findScenes"]["scenes"][number];

export async function fetchSceneDetails(
  ids: string[]
): Promise<FeedScene[]> {
  const numericIds = ids
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!numericIds.length) return [];
  return withTimeout(
    client
      .query<GQL.FindScenesQuery, GQL.FindScenesQueryVariables>({
        query: GQL.FindScenesDocument,
        // Bypass Apollo cache so captions / metadata changes since the
        // last feed render show up; cache-first was leaving stale
        // captions=null records on the page.
        fetchPolicy: "no-cache",
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
        return [] as FeedScene[];
      }),
    30_000,
    [] as FeedScene[]
  );
}

// Re-export so existing imports keep working
export type { AlgorithmSettings };

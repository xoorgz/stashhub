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

  const fetches: Array<Promise<BucketSpec | null>> = [];

  // Hottest. Prefer tag id; fall back to name lookup for older configs.
  if (settings.hottestEnabled && settings.hottestWeight > 0) {
    fetches.push(
      (async () => {
        const tagId =
          settings.hottestTagId || (await getHottestTagId(settings.hottestTagName));
        if (!tagId) return { name: "hottest", weight: settings.hottestWeight, ids: [] };
        const perPage = Math.max(5, Math.ceil(targetCount * 0.6 * over));
        const ids = await fetchBucket({
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
        const ids = await fetchBucket({
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

  // Top O-Count. Fetch top N by o_counter desc among scenes that meet the
  // minimum, then shuffle.
  if (settings.topOCountEnabled && settings.topOCountWeight > 0) {
    fetches.push(
      (async () => {
        const perPage = Math.max(5, Math.ceil(targetCount * 0.4 * over));
        const ids = await fetchBucket({
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
      fetchBucket({
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
      fetchBucket({
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
      fetchBucket({
        filter: { per_page: perPage, page: 1, sort: seed },
        sceneFilter: { organized: true },
      }).then((ids) => ({ name: "random", weight: settings.randomWeight, ids }))
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
    const fallback = await fetchBucket({
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

import { createHash } from "node:crypto";
import * as v from "valibot";
import { LISTENBRAINZ_LABS_API } from "../../config/constants.ts";
import { dbOps } from "../../db/helpers/index.ts";
import {
  builderArtist,
  builderText,
  builderTrack,
  type BuilderArtist,
  type RecommendationMode,
} from "../../routes/playlists/builderSchema.ts";
import { listenbrainzRequest } from "../apiClients/index.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import { readMany } from "../integrationData.ts";
import { getArtistTopTracks, getSimilarArtists } from "../musicDataSource/index.ts";
import { normalizeMbid } from "../musicDataSource/common.ts";

const algorithm =
  "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000";
const day = 86_400_000;
const recordingId = v.pipe(v.string(), v.uuid(), v.toLowerCase());
const recordingMatch = v.object({
  recording_mbid: recordingId,
  reference_mbid: recordingId,
  artist_credit_name: builderText,
  artist_credit_mbids: v.nullish(v.array(recordingId)),
  recording_name: builderText,
  release_name: v.nullish(v.string()),
  score: v.pipe(v.number(), v.finite(), v.minValue(0)),
});
type RecordingMatch = v.InferOutput<typeof recordingMatch>;

async function catalogList<Schema extends v.GenericSchema>(
  key: string,
  schema: Schema,
  mode: RecommendationMode | undefined,
  load: () => Promise<v.InferOutput<Schema>[]>,
): Promise<v.InferOutput<Schema>[]> {
  if (!mode) return load().catch(() => []);
  const stored = await dbOps.getMetadataResponseAsync(key);
  const parsed = v.safeParse(v.array(schema), stored?.value);
  const cached = parsed.success ? parsed.output : [];
  if (mode === "offline" || (parsed.success && stored && stored.freshUntil > Date.now()))
    return cached;
  try {
    const items = await load();
    if (!items.length && cached.length) return cached;
    await dbOps.setMetadataResponseAsync(key, {
      value: items,
      freshUntil: Date.now() + (items.length ? day : 300_000),
      staleUntil: Date.now() + 30 * day,
    });
    return items;
  } catch {
    return cached;
  }
}

export const catalogId = (artist: string, title: string, album: string | null, mbid?: string) =>
  "catalog:" +
  createHash("sha256")
    .update(JSON.stringify(mbid ? [artist, title, album, mbid] : [artist, title, album]))
    .digest("hex");

const artistKey = (artist: BuilderArtist) => artist.mbid || artist.name.toLowerCase();
export function catalogTracks(artist: BuilderArtist, mode?: RecommendationMode) {
  return catalogList("builder:tracks:" + artistKey(artist), builderTrack, mode, async () =>
    (await getArtistTopTracks(artist, { limit: 100 })).map(
      ({ artistName, name: trackName, albumName, mbid }) => {
        const recordingMbid = normalizeMbid(mbid);
        return {
          id: catalogId(artistName, trackName, albumName, recordingMbid ?? undefined),
          artistName,
          trackName,
          albumName,
          source: "discovery" as const,
          ...(recordingMbid && { recordingMbid }),
        };
      },
    ),
  );
}

export function relatedArtists(artist: BuilderArtist, mode?: RecommendationMode) {
  return catalogList("builder:related:" + artistKey(artist), builderArtist, mode, async () =>
    (await getSimilarArtists(artist, { limit: 12 })).map(({ name, mbid }) => ({
      name,
      mbid: mbid || null,
      libraryArtistId: null,
    })),
  );
}

export async function rankedRecordings(mbids: string[], mode: RecommendationMode) {
  const seeds = new Set(mbids);
  const lists = await mapWithConcurrency([...seeds], 2, (mbid) =>
    catalogList(
      `builder:similar-recordings:${algorithm}:${mbid}`,
      recordingMatch,
      mode,
      async () => {
        const endpoint = "/similar-recordings/json";
        const rows = await listenbrainzRequest(
          endpoint,
          { algorithm, recording_mbids: mbid },
          { baseUrl: LISTENBRAINZ_LABS_API, timeoutMs: 3500 },
        );
        return readMany(recordingMatch, rows, { service: "ListenBrainz", endpoint })
          .filter((row) => row.reference_mbid === mbid && row.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 100);
      },
    ),
  );
  const scores = new Map<string, { candidate: RecordingMatch; seeds: number; rank: number }>();
  for (const rows of lists) {
    const seen = new Set<string>();
    rows.forEach((candidate, index) => {
      const id = candidate.recording_mbid;
      if (seeds.has(id) || seen.has(id)) return;
      seen.add(id);
      const score = scores.get(id) ?? { candidate, seeds: 0, rank: 0 };
      score.seeds++;
      score.rank += 1 / (index + 1);
      scores.set(id, score);
    });
  }
  return [...scores.values()]
    .sort(
      (a, b) =>
        b.seeds - a.seeds ||
        b.rank - a.rank ||
        a.candidate.recording_mbid.localeCompare(b.candidate.recording_mbid),
    )
    .map(({ candidate }) => candidate);
}

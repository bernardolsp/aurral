import { randomUUID } from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type {
  BuilderArtist,
  BuilderSource,
  BuilderTrack,
  RecommendationMode,
} from "../../routes/playlists/builderSchema.ts";
import { shuffle } from "../../../lib/shuffle.ts";
import { matchesArtistKeys } from "../discovery/artistKeys.ts";
import { getBlockedArtistKeys } from "../discovery/feedback.ts";
import { interleaveLists, mapWithConcurrency } from "../discovery/helpers.ts";
import { searchArtists } from "../providers/brainzmashProvider.ts";
import {
  catalogId,
  catalogTracks,
  rankedRecordings,
  relatedArtists,
} from "./playlistBuilderCatalog.ts";
import { normalizeMbid } from "../musicDataSource/common.ts";
import { buildCoreTrackIdentity } from "./playlistTracks.ts";
import { playlistOperationQueue } from "./playlistOperationQueue.ts";

const artistFields = "artist.id AS libraryArtistId, artist.name, artist.mbid";
const available = "media.available = 1 AND media.source != 'flow'";
const credited = "(track.artist_name IS NULL OR track.artist_name = artist.name COLLATE NOCASE)";
const filesForArtist = `FROM library_albums AS album
  JOIN library_media_files AS media ON media.album_id = album.id
  JOIN library_tracks AS track ON track.id = media.track_id
  WHERE album.artist_id = artist.id AND ${available} AND ${credited}`;
const artistsByPrefix = db.prepare<[string], BuilderArtist>(`
  SELECT ${artistFields} FROM library_artists AS artist
  WHERE artist.name LIKE ? ESCAPE '\\' AND EXISTS (SELECT 1 ${filesForArtist})
  ORDER BY artist.name COLLATE NOCASE, artist.id LIMIT 20`);
const artistByMbid = db.prepare<[string], BuilderArtist>(
  `SELECT ${artistFields} FROM library_artists AS artist WHERE mbid = ? LIMIT 1`,
);
const artistByName = db.prepare<[string], BuilderArtist>(
  `SELECT ${artistFields} FROM library_artists AS artist WHERE name = ? COLLATE NOCASE LIMIT 1`,
);

function matchLibraryArtist(artist: BuilderArtist): BuilderArtist {
  if (artist.libraryArtistId) return artist;
  const byMbid = artist.mbid && artistByMbid.get(artist.mbid);
  if (byMbid) return byMbid;
  const byName = artistByName.get(artist.name);
  if (!byName || (artist.mbid && byName.mbid && artist.mbid !== byName.mbid)) return artist;
  return { ...byName, mbid: byName.mbid ?? artist.mbid };
}

const similarByGenre = db.prepare<[number, number, number], BuilderArtist>(`
  WITH genres AS (
    SELECT lower(name) AS genre FROM library_entity_genres WHERE entity_kind = 'artists' AND entity_id = ?
    UNION
    SELECT lower(g.name) FROM library_albums AS album
    JOIN library_entity_genres AS g ON g.entity_kind = 'albums' AND g.entity_id = album.id
    WHERE album.artist_id = ?
  ), related AS (
    SELECT g.entity_id AS artist_id, genres.genre FROM genres
    JOIN library_entity_genres AS g ON lower(g.name) = genres.genre AND g.entity_kind = 'artists'
    UNION
    SELECT album.artist_id, genres.genre FROM genres
    JOIN library_entity_genres AS g ON lower(g.name) = genres.genre AND g.entity_kind = 'albums'
    JOIN library_albums AS album ON album.id = g.entity_id
  )
  SELECT ${artistFields} FROM related JOIN library_artists AS artist ON artist.id = related.artist_id
  WHERE artist.id != ? AND EXISTS (SELECT 1 ${filesForArtist})
  GROUP BY artist.id ORDER BY COUNT(*) DESC, artist.name COLLATE NOCASE, artist.id LIMIT 12`);

const trackFields = `'library:' || media.id AS id, COALESCE(track.artist_name, artist.name) AS artistName,
   track.title AS trackName, album.title AS albumName, 'library' AS source`;
const tracksByArtist = db.prepare<[number], BuilderTrack>(`
  SELECT ${trackFields} FROM library_artists AS artist
  JOIN library_albums AS album ON album.artist_id = artist.id
  JOIN library_media_files AS media ON media.album_id = album.id
  JOIN library_tracks AS track ON track.id = media.track_id
  WHERE artist.id = ? AND ${available} AND ${credited}
  ORDER BY track.title COLLATE NOCASE, media.id LIMIT 250`);
const selectedFiles = db.prepare<[string], BuilderTrack & { path: string }>(`
  SELECT ${trackFields}, media.path FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  JOIN library_albums AS album ON album.id = media.album_id
  JOIN library_artists AS artist ON artist.id = album.artist_id
  WHERE media.id IN (SELECT value FROM json_each(?)) AND ${available}`);

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sameArtist(left: BuilderArtist, right: BuilderArtist) {
  if (left.mbid && right.mbid) return left.mbid === right.mbid;
  if (left.libraryArtistId && right.libraryArtistId)
    return left.libraryArtistId === right.libraryArtistId;
  return left.name.toLowerCase() === right.name.toLowerCase();
}

function uniqueArtists(artists: BuilderArtist[]) {
  return artists.filter(
    (artist, index) => artists.findIndex((item) => sameArtist(item, artist)) === index,
  );
}
export async function findBuilderArtists(
  q: string,
  source: BuilderSource,
  userId: number,
  signal?: AbortSignal,
  recommendationMode?: RecommendationMode,
) {
  const library = artistsByPrefix.all(q.replace(/[\\%_]/g, "\\$&") + "%");
  const catalog =
    source === "discovery" && recommendationMode !== "offline"
      ? (await searchArtists(q, { limit: 12, signal })).items
      : [];
  const blocked = getBlockedArtistKeys(String(userId));
  const artists = interleaveLists<BuilderArtist>(
    library,
    catalog.map(({ id: mbid, name }) => ({ name, mbid, libraryArtistId: null })),
  );
  return uniqueArtists(artists.filter((artist) => !matchesArtistKeys(artist, blocked))).slice(
    0,
    20,
  );
}

async function artistTracks(
  artist: BuilderArtist,
  source: BuilderSource,
  blocked: Set<string>,
  mode?: RecommendationMode,
) {
  if (matchesArtistKeys(artist, blocked)) return [];
  const local = artist.libraryArtistId ? tracksByArtist.all(artist.libraryArtistId) : [];
  const tracks = source === "discovery" ? await catalogTracks(artist, mode) : [];
  return uniqueBy(
    [...local, ...tracks].filter((track) => !matchesArtistKeys(track, blocked)),
    buildCoreTrackIdentity,
  );
}

export async function builderOptions(
  selected: BuilderArtist,
  source: BuilderSource,
  userId: number,
  mode?: RecommendationMode,
) {
  const artist = matchLibraryArtist(selected);
  const blocked = getBlockedArtistKeys(String(userId));
  if (matchesArtistKeys(artist, blocked)) return { tracks: [], similarArtists: [] };
  const local = artist.libraryArtistId
    ? similarByGenre.all(artist.libraryArtistId, artist.libraryArtistId, artist.libraryArtistId)
    : [];
  const [tracks, similar] = await Promise.all([
    artistTracks(artist, source, blocked, mode),
    source === "discovery" ? relatedArtists(artist, mode) : [],
  ]);
  const suggestions = interleaveLists<BuilderArtist>(local, similar).filter(
    (item) => !sameArtist(item, artist) && !matchesArtistKeys(item, blocked),
  );
  return { tracks, similarArtists: uniqueArtists(suggestions).slice(0, 12) };
}

const mbidsForSeeds = db.prepare<[string], { mbid: string }>(`
  SELECT DISTINCT track.mbid FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  WHERE media.id IN (SELECT value FROM json_each(?)) AND track.mbid IS NOT NULL AND ${available}`);

const catalogFiles = db.prepare<
  [string],
  BuilderTrack & { catalogId: string; artistMbid: string | null }
>(`
  WITH candidates AS (
    SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.recordingMbid') AS mbid,
      json_extract(value, '$.trackName') AS title, json_extract(value, '$.artistName') AS credit
    FROM json_each(?)
  ), matches AS (
    SELECT candidates.id, track.id AS trackId, 0 AS byName, candidates.credit FROM candidates
    JOIN library_tracks AS track ON track.mbid = candidates.mbid
    UNION ALL
    SELECT candidates.id, track.id AS trackId, 1 AS byName, candidates.credit FROM candidates
    JOIN library_tracks AS track ON track.title = candidates.title COLLATE NOCASE
    WHERE track.mbid IS NULL OR candidates.mbid IS NULL
  ), files AS (
    SELECT matches.id AS catalogId, ${trackFields}, artist.mbid AS artistMbid,
      ROW_NUMBER() OVER (PARTITION BY matches.id ORDER BY matches.byName, media.id) AS preference
    FROM matches
    JOIN library_tracks AS track ON track.id = matches.trackId
    JOIN library_media_files AS media ON media.track_id = track.id
    JOIN library_albums AS album ON album.id = media.album_id
    JOIN library_artists AS artist ON artist.id = album.artist_id
    WHERE ${available} AND (matches.byName = 0 OR COALESCE(track.artist_name, artist.name) = matches.credit COLLATE NOCASE)
  )
  SELECT catalogId, id, artistName, trackName, albumName, source, artistMbid FROM files WHERE preference = 1`);

function preferIndexedFiles(tracks: BuilderTrack[], blocked: Set<string>) {
  const catalog = tracks.filter((track) => track.source === "discovery");
  const files = new Map(
    (catalog.length ? catalogFiles.all(JSON.stringify(catalog)) : []).map(
      ({ catalogId, ...file }) => [catalogId, file],
    ),
  );
  return tracks.flatMap((track) => {
    const match = files.get(track.id);
    if (matchesArtistKeys(track, blocked) || matchesArtistKeys(match, blocked)) return [];
    if (!match) return [track];
    const { artistMbid: _artistMbid, ...file } = match;
    return [{ ...track, ...file }];
  });
}

const tagged = (tracks: BuilderTrack[], pickReason: NonNullable<BuilderTrack["pickReason"]>) =>
  tracks.map((track) => ({ ...track, pickReason }));

type BuilderPreview = {
  tracks: BuilderTrack[];
  missingArtists: string[];
  discoveryTeaser?: BuilderTrack[];
  recommendationBasis?: "recording" | "artist";
};

async function recordingCandidates(
  seeds: BuilderTrack[],
  mode: RecommendationMode,
  blocked: Set<string>,
  maxHops?: number,
) {
  const localSeedIds = seeds
    .filter((track) => track.source === "library")
    .map((track) => Number(track.id.slice("library:".length)));
  let frontier = [
    ...(localSeedIds.length
      ? mbidsForSeeds.all(JSON.stringify(localSeedIds)).map((row) => row.mbid)
      : []),
    ...seeds.map((track) => track.recordingMbid),
  ].flatMap((mbid) => normalizeMbid(mbid) ?? []);
  const seen = new Set(frontier);
  const layers: BuilderTrack[][] = [];
  for (const hop of [1, 2, 3] as const) {
    if (!frontier.length || hop > (maxHops ?? 1)) break;
    const matches = await rankedRecordings(frontier, mode);
    const candidates: BuilderTrack[] = [];
    for (const match of matches) {
      const {
        artist_credit_name: artistName,
        recording_name: trackName,
        recording_mbid: recordingMbid,
      } = match;
      if (seen.has(recordingMbid)) continue;
      seen.add(recordingMbid);
      if (matchesArtistKeys({ artistName, artistAliases: match.artist_credit_mbids }, blocked))
        continue;
      const albumName = match.release_name?.trim() || null;
      candidates.push({
        id: catalogId(artistName, trackName, albumName, recordingMbid),
        artistName,
        trackName,
        albumName,
        recordingMbid,
        source: "discovery",
        pickReason: "recording",
        ...(maxHops !== undefined && { recommendationHop: hop }),
      });
    }
    const tracks = preferIndexedFiles(candidates, blocked);
    layers.push(tracks);
    if (hop === (maxHops ?? 1)) break;
    // At most two new requests per depth. Prefer different artists among the strongest matches.
    const pool = tracks.slice(0, 12);
    const diverse = uniqueBy(pool, (track) => track.artistName.toLowerCase());
    frontier = [...new Set([...diverse, ...pool].map((track) => track.recordingMbid!))].slice(0, 2);
  }
  return layers;
}

function mixRecordingLayers(layers: BuilderTrack[][]) {
  const [direct = [], ...deeper] = layers;
  if (!deeper.length) return direct;
  // Give direct matches the first slot and two out of each following three when available.
  const further = interleaveLists(...deeper.reverse());
  return interleaveLists(
    direct.filter((_, i) => i % 2 === 0),
    further,
    direct.filter((_, i) => i % 2 === 1),
  );
}
async function recommendTracks({
  artists,
  byArtist,
  seeds,
  source,
  mode,
  size,
  blocked,
  missingArtists,
  maxHops,
}: {
  artists: BuilderArtist[];
  byArtist: BuilderTrack[][];
  seeds: BuilderTrack[];
  source: BuilderSource;
  mode: RecommendationMode;
  size: number;
  blocked: Set<string>;
  missingArtists: string[];
  maxHops?: number;
}): Promise<BuilderPreview> {
  const anchor = artists[0]!;
  const chosen = byArtist.map((pool) => tagged(shuffle(pool), "chosenArtist"));
  const reserved = uniqueBy(
    [
      ...tagged(seeds, "seed"),
      ...chosen.slice(seeds.length ? 1 : 0).flatMap((pool) => pool.slice(0, 1)),
    ],
    buildCoreTrackIdentity,
  );
  if (reserved.length >= size)
    return {
      tracks: reserved.slice(0, size),
      missingArtists,
      discoveryTeaser: [],
      recommendationBasis: "artist",
    };
  const layers = await recordingCandidates(seeds, mode, blocked, maxHops);
  const eligible = (track: BuilderTrack) => source === "discovery" || track.source === "library";
  const recordingPicks = mixRecordingLayers(layers.map((layer) => layer.filter(eligible)));
  const primary = uniqueBy([...reserved, ...recordingPicks], buildCoreTrackIdentity);
  let related: BuilderTrack[] = [];
  let genre: BuilderTrack[] = [];
  if (primary.length < size) {
    const neighbors = uniqueArtists((await relatedArtists(anchor, mode)).map(matchLibraryArtist))
      .filter(
        (item) =>
          !artists.some((chosenArtist) => sameArtist(chosenArtist, item)) &&
          !matchesArtistKeys(item, blocked),
      )
      .slice(0, 2);
    const pools = await mapWithConcurrency(neighbors, 2, (item) =>
      artistTracks(item, "discovery", blocked, mode),
    );
    related = tagged(preferIndexedFiles(interleaveLists(...pools), blocked), "relatedArtist");
    if (anchor.libraryArtistId) {
      const local = similarByGenre
        .all(anchor.libraryArtistId, anchor.libraryArtistId, anchor.libraryArtistId)
        .filter(
          (item) =>
            ![...artists, ...neighbors].some((other) => sameArtist(other, item)) &&
            !matchesArtistKeys(item, blocked),
        )
        .slice(0, 3);
      genre = tagged(
        interleaveLists(
          ...local.map((item) => shuffle(tracksByArtist.all(item.libraryArtistId!)).slice(0, size)),
        ),
        "genre",
      );
    }
  }
  const fallback = interleaveLists(related, genre, interleaveLists(...chosen)).filter(
    (track) => !matchesArtistKeys(track, blocked),
  );
  const tracks = uniqueBy([...primary, ...fallback.filter(eligible)], buildCoreTrackIdentity).slice(
    0,
    size,
  );
  const included = new Set(tracks.map(buildCoreTrackIdentity));
  const discoveryTeaser =
    source === "library"
      ? uniqueBy([...reserved, ...mixRecordingLayers(layers), ...fallback], buildCoreTrackIdentity)
          .slice(0, size)
          .filter(
            (track) => track.source === "discovery" && !included.has(buildCoreTrackIdentity(track)),
          )
          .slice(0, 3)
      : [];
  return {
    tracks,
    missingArtists,
    discoveryTeaser,
    recommendationBasis: [...tracks, ...discoveryTeaser].some(
      (track) => track.pickReason === "recording",
    )
      ? "recording"
      : "artist",
  };
}

export async function previewBuilderPlaylist(
  {
    source,
    artist,
    similarArtists,
    seedTrackIds,
    size,
    maxHops,
    recommendationMode = maxHops === undefined
      ? undefined
      : source === "library"
        ? "offline"
        : "online",
  }: {
    source: BuilderSource;
    artist: BuilderArtist;
    similarArtists: BuilderArtist[];
    seedTrackIds: string[];
    size: number;
    maxHops?: number;
    recommendationMode?: RecommendationMode;
  },
  userId: number,
): Promise<BuilderPreview | null> {
  const blocked = getBlockedArtistKeys(String(userId));
  const artists = uniqueArtists([artist, ...similarArtists].map(matchLibraryArtist));
  const byArtist = await mapWithConcurrency(artists, 2, (item) =>
    artistTracks(item, source, blocked, recommendationMode),
  );
  const [main = [], ...others] = byArtist;
  const missingArtists = artists
    .filter((_, index) => !byArtist[index]?.length)
    .map((item) => item.name);
  const byId = new Map(main.map((track) => [track.id, track]));
  const seeds = seedTrackIds.flatMap((id) => byId.get(id) ?? []);
  if (seeds.length !== seedTrackIds.length) return null;
  if (recommendationMode) {
    return recommendTracks({
      artists,
      byArtist,
      seeds,
      source,
      mode: recommendationMode,
      size,
      maxHops,
      blocked,
      missingArtists,
    });
  }
  const mainPool = shuffle(main);
  const otherPools = others.map((tracks) => shuffle(tracks));
  const pools = seeds.length ? [...otherPools, mainPool] : [mainPool, ...otherPools];
  return {
    tracks: uniqueBy([...seeds, ...interleaveLists(...pools)], buildCoreTrackIdentity).slice(
      0,
      size,
    ),
    missingArtists,
  };
}

export async function saveBuilderPlaylist(
  {
    name,
    source,
    recommendationMode,
    tracks,
  }: {
    name: string;
    source: BuilderSource;
    recommendationMode?: RecommendationMode;
    tracks: BuilderTrack[];
  },
  ownerUserId: number,
) {
  const localIds = tracks
    .filter((track) => track.source === "library")
    .map((track) => Number(track.id.slice("library:".length)));
  const indexed = new Map(selectedFiles.all(JSON.stringify(localIds)).map((row) => [row.id, row]));
  const blocked = getBlockedArtistKeys(String(ownerUserId));
  if (uniqueBy(tracks, buildCoreTrackIdentity).length !== tracks.length) return null;
  const accepted = [];
  for (const track of tracks) {
    if (matchesArtistKeys(track, blocked)) return null;
    if (track.source === "library") {
      const file = indexed.get(track.id);
      if (
        !file ||
        file.artistName !== track.artistName ||
        file.trackName !== track.trackName ||
        file.albumName !== track.albumName
      )
        return null;
      accepted.push({
        artistName: file.artistName,
        trackName: file.trackName,
        albumName: file.albumName,
        path: file.path,
      });
    } else {
      if (
        source === "library" ||
        track.id !==
          catalogId(track.artistName, track.trackName, track.albumName, track.recordingMbid)
      )
        return null;
      accepted.push({
        artistName: track.artistName,
        trackName: track.trackName,
        albumName: track.albumName,
        ...(track.recordingMbid && { trackMbid: track.recordingMbid }),
      });
    }
  }
  const playlistId = randomUUID();
  const { operationId } = await playlistOperationQueue.enqueuePayload({
    kind: "static-playlist-create",
    label: "static-playlist:create",
    ownerUserId,
    playlistId,
    name,
    tracks: accepted,
    downloadMissing: false,
    libraryOnly: source === "library",
    ...(recommendationMode === "offline" && { offlineMetadata: true }),
  });
  return { success: true, queued: true, playlistId, operationId };
}

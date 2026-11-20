import { createHash, randomUUID } from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type {
  BuilderArtist,
  BuilderSource,
  BuilderTrack,
} from "../../routes/playlists/builderSchema.ts";
import { shuffle } from "../../../lib/shuffle.ts";
import { matchesArtistKeys } from "../discovery/artistKeys.ts";
import { getBlockedArtistKeys } from "../discovery/feedback.ts";
import { interleaveLists, mapWithConcurrency } from "../discovery/helpers.ts";
import { searchArtists } from "../providers/brainzmashProvider.ts";
import { getArtistTopTracks, getSimilarArtists } from "../musicDataSource/index.ts";
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
const catalogId = (artist: string, title: string, album: string | null) =>
  "catalog:" +
  createHash("sha256")
    .update(JSON.stringify([artist, title, album]))
    .digest("hex");

export async function findBuilderArtists(
  q: string,
  source: BuilderSource,
  userId: number,
  signal?: AbortSignal,
) {
  const library = artistsByPrefix.all(q.replace(/[\\%_]/g, "\\$&") + "%");
  const catalog =
    source === "discovery" ? (await searchArtists(q, { limit: 12, signal })).items : [];
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

async function artistTracks(artist: BuilderArtist, source: BuilderSource, blocked: Set<string>) {
  if (matchesArtistKeys(artist, blocked)) return [];
  const local = artist.libraryArtistId ? tracksByArtist.all(artist.libraryArtistId) : [];
  const catalog =
    source === "discovery" ? await getArtistTopTracks(artist, { limit: 100 }).catch(() => []) : [];
  const tracks: BuilderTrack[] = catalog.map(({ artistName, name: trackName, albumName }) => ({
    id: catalogId(artistName, trackName, albumName),
    artistName,
    trackName,
    albumName,
    source: "discovery",
  }));
  return uniqueBy(
    [...local, ...tracks].filter((track) => !matchesArtistKeys(track, blocked)),
    buildCoreTrackIdentity,
  );
}

export async function builderOptions(
  selected: BuilderArtist,
  source: BuilderSource,
  userId: number,
) {
  const artist = matchLibraryArtist(selected);
  const blocked = getBlockedArtistKeys(String(userId));
  if (matchesArtistKeys(artist, blocked)) return { tracks: [], similarArtists: [] };
  const local = artist.libraryArtistId
    ? similarByGenre.all(artist.libraryArtistId, artist.libraryArtistId, artist.libraryArtistId)
    : [];
  const [tracks, similar] = await Promise.all([
    artistTracks(artist, source, blocked),
    source === "discovery" ? getSimilarArtists(artist, { limit: 12 }).catch(() => []) : [],
  ]);
  const suggestions = interleaveLists<BuilderArtist>(
    local,
    similar.map(({ name, mbid }) => ({ name, mbid: mbid || null, libraryArtistId: null })),
  ).filter((item) => !sameArtist(item, artist) && !matchesArtistKeys(item, blocked));
  return { tracks, similarArtists: uniqueArtists(suggestions).slice(0, 12) };
}

export async function previewBuilderPlaylist(
  {
    source,
    artist,
    similarArtists,
    seedTrackIds,
    size,
  }: {
    source: BuilderSource;
    artist: BuilderArtist;
    similarArtists: BuilderArtist[];
    seedTrackIds: string[];
    size: number;
  },
  userId: number,
) {
  const blocked = getBlockedArtistKeys(String(userId));
  const artists = uniqueArtists([artist, ...similarArtists].map(matchLibraryArtist));
  const byArtist = await mapWithConcurrency(artists, 2, (item) =>
    artistTracks(item, source, blocked),
  );
  const [main = [], ...others] = byArtist;
  const missingArtists = artists
    .filter((_, index) => !byArtist[index]?.length)
    .map((item) => item.name);
  const byId = new Map(main.map((track) => [track.id, track]));
  const seeds = seedTrackIds.flatMap((id) => byId.get(id) ?? []);
  if (seeds.length !== seedTrackIds.length) return null;
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
    tracks,
  }: {
    name: string;
    source: BuilderSource;
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
        track.id !== catalogId(track.artistName, track.trackName, track.albumName)
      )
        return null;
      accepted.push({
        artistName: track.artistName,
        trackName: track.trackName,
        albumName: track.albumName,
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
  });
  return { success: true, queued: true, playlistId, operationId };
}

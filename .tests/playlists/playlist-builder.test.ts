import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterAll, afterEach, test, vi } from "vite-plus/test";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const [
  state,
  { db },
  media,
  builder,
  metadata,
  catalog,
  operations,
  { playlistOperationQueue },
  { flowPlaylistConfig },
  artwork,
  routes,
] = await setupIsolatedBackend(
  "playlist-builder",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/playlists/playlistBuilder.ts"),
  () => import("../../backend/services/musicDataSource/index.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/services/playlists/playlistOperations.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlistArtworkState.ts"),
  () => import("../../backend/routes/playlists/handlers/builder.ts"),
);

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupIsolatedState(state));

async function addArtist(name: string, songs: string[]) {
  const artist = media.upsertLibraryArtist({ identityKey: name, name });
  const album = media.upsertLibraryAlbum({
    identityKey: name,
    artistId: artist.id,
    title: name,
    metadata: { genres: ["Ambient"] },
  });
  for (const title of songs) {
    const track = media.upsertLibraryTrack({ identityKey: name + title, title, artistName: name });
    media.linkLibraryAlbumTrack({ trackId: track.id, albumId: album.id });
    const file = path.join(state.baseDir, name + title + ".flac");
    await writeFile(file, "audio fixture");
    media.upsertLibraryMediaFile({
      trackId: track.id,
      albumId: album.id,
      source: "readonly",
      path: file,
      available: title !== "Missing",
    });
  }
  return { name, libraryArtistId: artist.id, mbid: null };
}

const main = await addArtist("Violet", ["Sky", "Arc", "Missing"]);
const other = await addArtist("Solar", ["Rise"]);
await addArtist("Violet Ghost", ["Missing"]);

test("Library previews reserve seeds, include chosen artists, and save the reviewed order with local files", async () => {
  const search = vi.spyOn(catalog, "searchArtists");
  const top = vi.spyOn(metadata, "getArtistTopTracks");
  const similar = vi.spyOn(metadata, "getSimilarArtists");
  const artists = await builder.findBuilderArtists("Viol", "library", 1);
  assert.deepEqual(artists, [main]);
  const options = await builder.builderOptions(main, "library", 1);
  assert.deepEqual(options.similarArtists, [other]);
  assert.deepEqual(
    options.tracks.map((track) => track.trackName),
    ["Arc", "Sky"],
  );
  const seed = options.tracks[1]!;
  const recipe = {
    source: "library" as const,
    artist: main,
    seedTrackIds: [seed.id],
    similarArtists: [other],
    size: 20,
  };
  const preview = await builder.previewBuilderPlaylist(recipe, 1);
  assert.deepEqual(
    preview?.tracks.map((track) => track.trackName),
    ["Sky", "Rise", "Arc"],
  );
  assert.ok(preview);
  assert.equal(
    await builder.previewBuilderPlaylist({ ...recipe, seedTrackIds: ["unknown"] }, 1),
    null,
  );
  const enqueue = vi.spyOn(playlistOperationQueue, "enqueuePayload");
  const saved = await builder.saveBuilderPlaylist(
    { source: "library", name: "Evening", tracks: preview.tracks },
    1,
  );
  assert.ok(saved);
  const payload = enqueue.mock.calls[0]?.[0];
  assert.ok(payload);
  await operations.processPlaylistOperation(payload);
  const playlist = flowPlaylistConfig.getStaticPlaylist(saved.playlistId);
  assert.equal(playlist?.ownerUserId, 1);
  assert.deepEqual(
    playlist?.tracks.map((track) => track.trackName),
    ["Sky", "Rise", "Arc"],
  );
  assert.ok(playlist?.tracks.every((track) => !!track.canonicalJobId));
  assert.equal(artwork.getPlaylistArtworkState(saved.playlistId)?.mode, "simple");
  assert.equal(search.mock.calls.length + top.mock.calls.length + similar.mock.calls.length, 0);
  db.prepare("UPDATE library_media_files SET available = 0 WHERE id = ?").run(
    Number(seed.id.split(":")[1]),
  );
  try {
    assert.equal(
      await builder.saveBuilderPlaylist(
        { source: "library", name: "Stale", tracks: preview.tracks },
        1,
      ),
      null,
    );
    assert.equal(enqueue.mock.calls.length, 1);
  } finally {
    db.prepare("UPDATE library_media_files SET available = 1 WHERE id = ?").run(
      Number(seed.id.split(":")[1]),
    );
  }
});

test("Discovery prefers matching Library songs and can save a catalog seed without downloads", async () => {
  const catalogTrack = (name: string) => ({
    name,
    artistName: main.name,
    albumName: main.name,
    mbid: null,
    durationMs: null,
    popularity: 1,
    previewUrl: null,
    artworkUrl: null,
    deezerAlbumId: null,
  });
  vi.spyOn(metadata, "getArtistTopTracks").mockResolvedValue([
    catalogTrack("Sky"),
    catalogTrack("Air"),
  ]);
  vi.spyOn(metadata, "getSimilarArtists").mockRejectedValue(new Error("Provider unavailable"));
  const ref = { ...main, libraryArtistId: null };
  const options = await builder.builderOptions(ref, "discovery", 1);
  assert.deepEqual(
    options.tracks.map(({ trackName, source }) => [trackName, source]),
    [
      ["Arc", "library"],
      ["Sky", "library"],
      ["Air", "discovery"],
    ],
  );
  assert.deepEqual(options.similarArtists, [other]);
  const seed = options.tracks[2]!;
  const preview = await builder.previewBuilderPlaylist(
    { source: "discovery", artist: ref, similarArtists: [], seedTrackIds: [seed.id], size: 1 },
    1,
  );
  assert.deepEqual(preview, { tracks: [seed], missingArtists: [] });
  vi.mocked(metadata.getArtistTopTracks).mockRejectedValue(new Error("Provider unavailable"));
  const unavailable = { name: "Unindexed", libraryArtistId: null, mbid: null };
  const partial = await builder.previewBuilderPlaylist(
    {
      source: "discovery",
      artist: ref,
      similarArtists: [unavailable],
      seedTrackIds: [],
      size: 2,
    },
    1,
  );
  assert.deepEqual(partial?.missingArtists, ["Unindexed"]);
  assert.equal(partial?.tracks.length, 2);
  const enqueue = vi.spyOn(playlistOperationQueue, "enqueuePayload");
  assert.equal(
    await builder.saveBuilderPlaylist({ source: "library", name: "Mixed", tracks: [seed] }, 1),
    null,
  );
  assert.ok(
    await builder.saveBuilderPlaylist({ source: "discovery", name: "Mixed", tracks: [seed] }, 1),
  );
  assert.equal(enqueue.mock.calls[0]?.[0].downloadMissing, false);
});

test("Playlist Builder rejects unauthorized access and invalid recipe sizes", async () => {
  const blocked = signedInAs(testUser(5, { permissions: { accessPlaylists: false } })).route(
    "/",
    routes.default,
  );
  const reader = signedInAs(testUser(1, { permissions: { accessPlaylists: true } })).route(
    "/",
    routes.default,
  );
  assert.equal(
    (await blocked.request("/playlists/builder/artists?q=x&source=library")).status,
    403,
  );
  const payload = {
    source: "library",
    artist: main,
    similarArtists: [],
    seedTrackIds: ["1", "2"],
    size: 1,
  };
  assert.equal(
    (
      await reader.request("/playlists/builder/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    ).status,
    400,
  );
});

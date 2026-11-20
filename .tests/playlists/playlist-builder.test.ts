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

test("recording recommendations reserve chosen artists, rank agreement between seeds, and compare the available Library with Discovery", async () => {
  const clients = await import("../../backend/services/apiClients/index.ts");
  const mbid = (n: number) => `0b4a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const anchor = await addArtist("Dual seed", ["One", "Two"]);
  await addArtist("Low tide", ["Shared", "Single", "Missing"]);
  db.prepare("UPDATE library_tracks SET mbid = ? WHERE artist_name = ? AND title = ?").run(
    mbid(1),
    anchor.name,
    "One",
  );
  db.prepare("UPDATE library_tracks SET mbid = ? WHERE artist_name = ? AND title = ?").run(
    mbid(2),
    anchor.name,
    "Two",
  );
  db.prepare(
    "UPDATE library_tracks SET mbid = ? WHERE artist_name = 'Low tide' AND title = 'Shared'",
  ).run(mbid(3));
  const row = (reference: string, id: number, title: string, score: number) => ({
    reference_mbid: reference,
    recording_mbid: mbid(id),
    recording_name: title,
    artist_credit_name: "Low tide",
    artist_credit_mbids: null,
    release_name: "Low tide",
    score,
  });
  const remote = vi
    .spyOn(clients, "listenbrainzRequest")
    .mockImplementation(async (route, query) => {
      assert.equal(route, "/similar-recordings/json");
      assert.deepEqual(Object.keys(query ?? {}).sort(), ["algorithm", "recording_mbids"]);
      assert.ok(query && "recording_mbids" in query);
      const from = String(query.recording_mbids);
      assert.ok(from === mbid(1) || from === mbid(2));
      return from === mbid(1)
        ? [
            row(from, 4, "Single", 500),
            row(from, 3, "Provider title for Shared", 100),
            row(from, 5, "Missing", 50),
            row(mbid(7), 9, "Wrong seed", 1000),
          ]
        : [row(from, 3, "Provider title for Shared", 50), row(from, 5, "Missing", 40)];
    });
  const top = vi.spyOn(metadata, "getArtistTopTracks").mockResolvedValue([]);
  const similar = vi.spyOn(metadata, "getSimilarArtists").mockResolvedValue([]);
  const { tracks: options } = await builder.builderOptions(anchor, "library", 1, "online");
  const recipe = {
    artist: anchor,
    similarArtists: [other],
    seedTrackIds: options.map((track) => track.id),
    size: 5,
  };
  const preview = await builder.previewBuilderPlaylist(
    { ...recipe, source: "library", recommendationMode: "online" },
    1,
  );
  assert.deepEqual(
    preview?.tracks.map(({ trackName, pickReason }) => [trackName, pickReason]),
    [
      ["One", "seed"],
      ["Two", "seed"],
      ["Rise", "chosenArtist"],
      ["Shared", "recording"],
      ["Single", "recording"],
    ],
  );
  assert.ok(preview?.tracks.every((track) => track.source === "library"));
  assert.deepEqual(
    preview.discoveryTeaser?.map((track) => track.trackName),
    ["Missing"],
  );
  assert.equal(preview.recommendationBasis, "recording");
  assert.equal(remote.mock.calls.length, 2);

  remote.mockClear();
  const locked = await builder.previewBuilderPlaylist(
    {
      ...recipe,
      source: "library",
      recommendationMode: "online",
      size: 1,
      seedTrackIds: [recipe.seedTrackIds[0]!],
      similarArtists: [],
    },
    1,
  );
  assert.deepEqual(locked?.discoveryTeaser, []);
  assert.deepEqual(
    locked?.tracks.map((track) => track.trackName),
    ["One"],
  );
  assert.equal(remote.mock.calls.length, 0);
  const expanded = await builder.previewBuilderPlaylist(
    { ...recipe, source: "discovery", recommendationMode: "offline" },
    1,
  );
  assert.deepEqual(
    expanded?.tracks.map((track) => track.trackName),
    ["One", "Two", "Rise", "Shared", "Missing"],
  );
  assert.equal(remote.mock.calls.length + top.mock.calls.length + similar.mock.calls.length, 0);
  assert.ok(expanded);
  const queued = vi.spyOn(playlistOperationQueue, "enqueuePayload");
  const saved = await builder.saveBuilderPlaylist(
    {
      name: "Expanded cached mix",
      source: "discovery",
      recommendationMode: "offline",
      tracks: expanded.tracks,
    },
    1,
  );
  assert.ok(saved);
  const operation = queued.mock.calls[0]?.[0];
  assert.ok(operation);
  assert.equal(operation.downloadMissing, false);
  await operations.processPlaylistOperation(operation);
  const savedPlaylist = flowPlaylistConfig.getStaticPlaylist(saved.playlistId);
  assert.equal(savedPlaylist?.tracks.at(-1)?.trackMbid, mbid(5));
  assert.equal(artwork.getPlaylistArtworkState(saved.playlistId)?.mode, "simple");
  assert.equal(remote.mock.calls.length + top.mock.calls.length + similar.mock.calls.length, 0);
});

test("cold offline recipes use local genres, and warm offline recipes keep catalog seeds without provider lookups", async () => {
  const search = vi.spyOn(catalog, "searchArtists");
  const top = vi.spyOn(metadata, "getArtistTopTracks").mockResolvedValue([
    {
      name: "Afterglow",
      artistName: main.name,
      albumName: "Night",
      mbid: null,
      durationMs: null,
      popularity: 1,
      previewUrl: null,
      artworkUrl: null,
      deezerAlbumId: null,
    },
  ]);
  const similar = vi.spyOn(metadata, "getSimilarArtists").mockResolvedValue([]);
  assert.deepEqual(
    await builder.findBuilderArtists("Violet", "discovery", 1, undefined, "offline"),
    [main],
  );
  const cold = await builder.previewBuilderPlaylist(
    {
      source: "library",
      recommendationMode: "offline",
      artist: main,
      similarArtists: [],
      seedTrackIds: [],
      size: 5,
    },
    1,
  );
  assert.ok(cold);
  assert.ok(cold.tracks.some((track) => track.pickReason === "genre"));
  assert.deepEqual(cold.discoveryTeaser, []);
  assert.equal(top.mock.calls.length + similar.mock.calls.length + search.mock.calls.length, 0);

  const { tracks } = await builder.builderOptions(main, "discovery", 1, "online");
  const selected = tracks.find((track) => track.trackName === "Afterglow");
  assert.ok(selected);
  top.mockClear();
  similar.mockClear();
  const warm = await builder.previewBuilderPlaylist(
    {
      source: "discovery",
      recommendationMode: "offline",
      artist: main,
      similarArtists: [],
      seedTrackIds: [selected.id],
      size: 1,
    },
    1,
  );
  assert.equal(warm?.tracks[0]?.id, selected.id);
  assert.equal(top.mock.calls.length + similar.mock.calls.length + search.mock.calls.length, 0);
});

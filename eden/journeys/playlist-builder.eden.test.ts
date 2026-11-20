import assert from "node:assert/strict";
import * as v from "valibot";
import { test } from "vite-plus/test";
import { builderArtist, builderTrack } from "../../backend/routes/playlists/builderSchema.ts";
import { api, getJson, ports } from "./eden.ts";
import { local } from "../services/service.ts";

const preview = v.object({
  tracks: v.array(v.object({ ...builderTrack.entries, pickReason: v.string() })),
  discoveryTeaser: v.array(builderTrack),
});

test("Library recommendations keep local files playable and show cached discoveries offline", async () => {
  const { artists } = v.parse(
    v.object({ artists: v.array(builderArtist) }),
    await api.get(
      "/playlists/builder/artists?source=library&recommendationMode=offline&q=Radiohead",
    ),
  );
  const artist = artists.find((entry) => entry.name === "Radiohead");
  assert.ok(artist);
  const { tracks } = v.parse(
    v.object({ tracks: v.array(builderTrack) }),
    await api.post("/playlists/builder/options", {
      source: "library",
      recommendationMode: "offline",
      artist,
    }),
  );
  const seed = tracks.find((track) => track.trackName === "Airbag");
  assert.ok(seed);
  const recipe = {
    source: "library",
    artist,
    seedTrackIds: [seed.id],
    similarArtists: [],
    size: 12,
  };
  const build = async (recommendationMode: string, maxHops?: number) =>
    v.parse(
      preview,
      await api.post("/playlists/builder/preview", { ...recipe, recommendationMode, maxHops }),
    );
  const online = await build("online");
  assert.equal(online.tracks[0]?.id, seed.id);
  assert.ok(online.tracks.some((track) => track.pickReason === "recording"));
  assert.ok(online.tracks.every((track) => track.source === "library"));
  assert.ok(
    online.discoveryTeaser.length > 0 &&
      online.discoveryTeaser.every((track) => track.source === "discovery"),
  );
  const recordingCalls = async () =>
    v
      .parse(
        v.array(v.object({ path: v.string() })),
        await getJson(`${local(ports.outside)}/requests`),
      )
      .filter(({ path }) => path.startsWith("/similar-recordings/json")).length;
  const calls = await recordingCalls();
  assert.ok(calls > 0);
  const offline = await build("offline");
  assert.equal(await recordingCalls(), calls);
  assert.deepEqual(
    offline.discoveryTeaser.map((track) => track.id),
    online.discoveryTeaser.map((track) => track.id),
  );
  assert.ok(offline.tracks.every((track) => track.source === "library"));

  const deep = await build("online", 3);
  assert.equal(deep.tracks[0]?.id, seed.id);
  assert.ok(deep.tracks.every((track) => track.source === "library"));
  const deeperIds = (result: typeof deep) =>
    result.tracks.filter((track) => (track.recommendationHop ?? 0) > 1).map((track) => track.id);
  assert.ok(deeperIds(deep).length > 0);
  const warmCalls = await recordingCalls();
  assert.ok(warmCalls <= calls + 4);
  const cached = await build("offline", 3);
  assert.deepEqual(deeperIds(cached), deeperIds(deep));
  assert.equal(await recordingCalls(), warmCalls);
});

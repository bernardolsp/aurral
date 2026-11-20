import { Hono } from "hono";
import * as v from "valibot";
import {
  builderArtist,
  builderSource,
  builderText,
  builderTrack,
  recommendationMode,
} from "../builderSchema.ts";
import { validate } from "../../../middleware/validate.ts";
import { requireUserAccount } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import {
  findBuilderArtists,
  builderOptions,
  previewBuilderPlaylist,
  saveBuilderPlaylist,
} from "../../../services/playlists/playlistBuilder.ts";
import { requirePlaylistAccess } from "./utils.ts";

const mode = v.optional(recommendationMode);
const selection = { source: builderSource, artist: builderArtist, recommendationMode: mode };
const preview = v.pipe(
  v.object({
    ...selection,
    seedTrackIds: v.pipe(v.array(builderText), v.maxLength(5)),
    similarArtists: v.pipe(v.array(builderArtist), v.maxLength(5)),
    size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  }),
  v.check(
    ({ seedTrackIds, similarArtists, size }) =>
      Math.max(1, seedTrackIds.length) + similarArtists.length <= size,
    "Choose a size that fits the seed songs and included artists.",
  ),
  v.check(
    ({ seedTrackIds }) => new Set(seedTrackIds).size === seedTrackIds.length,
    "Select each seed song once.",
  ),
);

export default new Hono<AppEnv>()
  .basePath("/playlists/builder")
  .get(
    "/artists",
    requirePlaylistAccess,
    validate(
      "query",
      v.object({ q: builderText, source: builderSource, recommendationMode: mode }),
    ),
    async (c) => {
      const { q, source, recommendationMode } = c.req.valid("query");
      return c.json(
        {
          artists: await findBuilderArtists(
            q,
            source,
            c.var.user.id,
            c.req.raw.signal,
            recommendationMode,
          ),
        },
        200,
      );
    },
  )
  .post("/options", requirePlaylistAccess, validate("json", v.object(selection)), async (c) => {
    const { source, artist, recommendationMode } = c.req.valid("json");
    return c.json(await builderOptions(artist, source, c.var.user.id, recommendationMode), 200);
  })
  .post("/preview", requirePlaylistAccess, validate("json", preview), async (c) => {
    const result = await previewBuilderPlaylist(c.req.valid("json"), c.var.user.id);
    if (!result)
      return c.json(
        { error: "A seed song is no longer available. Choose your seed songs again." },
        409,
      );
    return c.json(result, 200);
  })
  .post(
    "/save",
    requirePlaylistAccess,
    requireUserAccount,
    validate(
      "json",
      v.object({
        source: builderSource,
        recommendationMode: mode,
        name: builderText,
        tracks: v.pipe(v.array(builderTrack), v.minLength(1), v.maxLength(100)),
      }),
    ),
    async (c) => {
      const result = await saveBuilderPlaylist(c.req.valid("json"), c.var.user.id);
      if (!result)
        return c.json({ error: "The selected tracks changed. Preview the playlist again." }, 409);
      return c.json(result, 200);
    },
  );

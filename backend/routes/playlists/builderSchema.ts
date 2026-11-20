import * as v from "valibot";

export const builderText = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(500));
export const builderSource = v.picklist(["library", "discovery"]);
export const recommendationMode = v.picklist(["offline", "online"]);
export type RecommendationMode = v.InferOutput<typeof recommendationMode>;
export const builderArtist = v.object({
  name: builderText,
  mbid: v.nullable(v.pipe(v.string(), v.uuid())),
  libraryArtistId: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
});
export const builderTrack = v.object({
  id: builderText,
  artistName: builderText,
  trackName: builderText,
  albumName: v.nullable(builderText),
  source: builderSource,
  recordingMbid: v.optional(v.pipe(v.string(), v.uuid())),
  recommendationHop: v.optional(v.picklist([1, 2, 3])),
  pickReason: v.optional(
    v.picklist(["seed", "recording", "chosenArtist", "relatedArtist", "genre"]),
  ),
});

export type BuilderArtist = v.InferOutput<typeof builderArtist>;
export type BuilderTrack = v.InferOutput<typeof builderTrack>;
export type BuilderSource = BuilderTrack["source"];

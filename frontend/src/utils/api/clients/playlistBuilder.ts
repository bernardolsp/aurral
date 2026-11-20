import { hc, parseResponse, type InferRequestType } from "hono/client";
import type builder from "../../../../../backend/routes/playlists/handlers/builder.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistBuilderClient = hc<typeof builder>(API_BASE_URL, { fetch: apiFetch }).playlists
  .builder;

type PreviewRecipe = InferRequestType<typeof playlistBuilderClient.preview.$post>["json"];
export type BuilderRecommendationMode = PreviewRecipe["recommendationMode"];
export const fetchBuilderPreview = async (recipe: PreviewRecipe) => ({
  recipe,
  result: await parseResponse(playlistBuilderClient.preview.$post({ json: recipe })),
});
export type BuilderReview = Awaited<ReturnType<typeof fetchBuilderPreview>>;

export const builderActionKey = ["playlist-builder", "action"];

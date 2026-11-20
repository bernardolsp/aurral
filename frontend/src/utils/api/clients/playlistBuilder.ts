import { hc } from "hono/client";
import type builder from "../../../../../backend/routes/playlists/handlers/builder.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistBuilderClient = hc<typeof builder>(API_BASE_URL, { fetch: apiFetch }).playlists
  .builder;

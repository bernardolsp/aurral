import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type {
  BuilderArtist,
  BuilderSource,
} from "../../../../backend/routes/playlists/builderSchema.ts";
import { Plus, Search, User } from "../../components/icons";
import { SkeletonStatus, SkeletonText } from "../../components/Skeletons";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { playlistBuilderClient } from "../../utils/api/clients/playlistBuilder.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";

export const artistKey = (artist: BuilderArtist) =>
  artist.mbid ?? String(artist.libraryArtistId ?? artist.name.toLowerCase());

export function BuilderLookupError({
  error,
  label,
  onRetry,
}: {
  error: unknown;
  label: string;
  onRetry: () => void;
}) {
  return (
    <div className="builder-notice" role="alert">
      <span>{getApiErrorMessage(error, label)}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function BuilderLoading({ label }: { label: string }) {
  return (
    <SkeletonStatus label={label}>
      <div className="builder-skeleton">
        <SkeletonText width="42%" />
        <SkeletonText width="58%" />
        <SkeletonText width="36%" />
      </div>
    </SkeletonStatus>
  );
}

export function BuilderArtistSearch({
  label,
  source,
  exclude,
  onPick,
}: {
  label: string;
  source: BuilderSource;
  exclude: BuilderArtist[];
  onPick: (artist: BuilderArtist) => void;
}) {
  const id = useId();
  const [input, setInput] = useState("");
  const term = input.trim();
  const q = useDebouncedValue(term, 300);
  const query = useQuery({
    queryKey: ["playlist-builder", "artists", source, q],
    enabled: q.length > 0 && q === term,
    queryFn: ({ signal }) =>
      parseResponse(
        playlistBuilderClient.artists.$get({ query: { q, source } }, { init: { signal } }),
      ),
  });
  const options = query.data?.artists.filter(
    (artist) => !exclude.some((other) => artistKey(other) === artistKey(artist)),
  );

  return (
    <div className="builder-field">
      <label htmlFor={id} className="artist-field-label">
        {label}
      </label>
      <div className="builder-search">
        <Search aria-hidden="true" />
        <input
          id={id}
          className="input input--tall"
          type="search"
          autoComplete="off"
          maxLength={500}
          value={input}
          placeholder="Search artists"
          onChange={(event) => setInput(event.target.value)}
        />
      </div>
      {term ? (
        q !== term || query.isPending ? (
          <BuilderLoading label="Searching artists" />
        ) : query.isError ? (
          <BuilderLookupError
            error={query.error}
            label="Couldn't load artists"
            onRetry={() => void query.refetch()}
          />
        ) : options?.length ? (
          <ul className="builder-list" aria-label={label + " results"}>
            {options.map((artist) => (
              <li key={artistKey(artist)}>
                <button
                  type="button"
                  className="builder-row"
                  onClick={() => {
                    setInput("");
                    onPick(artist);
                  }}
                >
                  <User aria-hidden="true" />
                  <span className="builder-row__copy">
                    <strong>{artist.name}</strong>
                    {source === "discovery" && (
                      <small>{artist.libraryArtistId ? "Library" : "Catalog"}</small>
                    )}
                  </span>
                  <Plus aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="builder-hint" role="status">
            No matching artists{source === "library" ? " in your Library" : ""}.
          </p>
        )
      ) : null}
    </div>
  );
}

import { useState } from "react";
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type {
  BuilderArtist,
  BuilderSource,
} from "../../../../backend/routes/playlists/builderSchema.ts";
import ArtistImage from "../../components/ArtistImage";
import { asApiError, buildAuthenticatedApiUrl } from "../../utils/api/core.ts";
import { DotLoader } from "../../components/DotLoader";
import { Check, Compass, Info, Library, ListMusic, Music, Plus, X } from "../../components/icons";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { BuilderPreview } from "./BuilderPreview";
import { useAuth } from "../../contexts/AuthContext";
import PillToggle from "../../components/PillToggle";
import TooltipButton from "../../components/TooltipButton";
import {
  builderActionKey,
  fetchBuilderPreview,
  playlistBuilderClient,
  type BuilderRecommendationMode,
  type BuilderReview,
} from "../../utils/api/clients/playlistBuilder.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import {
  artistKey,
  BuilderArtistSearch,
  BuilderLoading,
  BuilderLookupError,
} from "./BuilderArtistSearch";
import "./playlistBuilder.css";

const MAX_PICKS = 5;
const HOP_OPTIONS = [
  { value: 1, label: "1 hop" },
  { value: 2, label: "2 hops" },
  { value: 3, label: "3 hops" },
] as const;
const SOURCES = [
  { value: "library", label: "My library", icon: Library },
  { value: "discovery", label: "Library + discovery", icon: Compass },
] as const;

function BuilderRecipe({
  artist,
  source,
  recommendationMode,
  review,
  onReview,
  onEdit,
}: {
  artist: BuilderArtist;
  source: BuilderSource;
  recommendationMode: BuilderRecommendationMode;
  review: BuilderReview | null;
  onReview: (review: BuilderReview) => void;
  onEdit: () => void;
}) {
  const [selectedSeeds, setSelectedSeeds] = useState<string[]>([]);
  const [similarArtists, setSimilarArtists] = useState<BuilderArtist[]>([]);
  const { bootstrap } = useAuth();
  const exploreFurther = bootstrap?.api?.features?.includes("playlistBuilderExploreFurther");
  const [maxHops, setMaxHops] = useState<(typeof HOP_OPTIONS)[number]["value"]>(1);
  const [showHopHelp, setShowHopHelp] = useState(false);
  const [sizeInput, setSizeInput] = useState("20");
  const [filter, setFilter] = useState("");
  const options = useQuery({
    queryKey: ["playlist-builder", "options", source, artist, recommendationMode],
    enabled: !review,
    queryFn: ({ signal }) =>
      parseResponse(
        playlistBuilderClient.options.$post(
          { json: { source, artist, recommendationMode } },
          { init: { signal } },
        ),
      ),
  });
  const seedTrackIds = selectedSeeds.filter((id) =>
    options.data?.tracks.some((track) => track.id === id),
  );
  const size = Number(sizeInput);
  const minSize = Math.max(1, seedTrackIds.length) + similarArtists.length;
  const validSize = Number.isInteger(size) && size >= minSize && size <= 100;
  const preview = useMutation({
    mutationKey: builderActionKey,
    mutationFn: () =>
      fetchBuilderPreview({
        source,
        artist,
        seedTrackIds,
        similarArtists,
        size,
        recommendationMode,
        ...(exploreFurther && { maxHops }),
      }),
    onError: async (error) => {
      if (asApiError(error)?.response?.status !== 409) return;
      const refreshed = await options.refetch();
      if (refreshed.isSuccess) {
        const available = new Set(refreshed.data.tracks.map((track) => track.id));
        setSelectedSeeds((ids) => ids.filter((id) => available.has(id)));
      }
    },
  });
  const toggleArtist = (next: BuilderArtist) => {
    setSimilarArtists((previous) =>
      previous.some((item) => artistKey(item) === artistKey(next))
        ? previous.filter((item) => artistKey(item) !== artistKey(next))
        : [...previous, next],
    );
  };
  if (review) return <BuilderPreview review={review} onEdit={onEdit} onExpand={onReview} />;
  if (options.isPending) return <BuilderLoading label={`Loading tracks for ${artist.name}`} />;
  if (options.isError)
    return (
      <BuilderLookupError
        error={options.error}
        label="Couldn't load tracks and similar artists"
        onRetry={() => void options.refetch()}
      />
    );
  const matchingTracks = options.data.tracks.filter((track) =>
    track.trackName.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const suggestions = options.data.similarArtists.filter(
    (candidate) => !similarArtists.some((item) => artistKey(item) === artistKey(candidate)),
  );

  return (
    <fieldset className="builder-recipe" disabled={preview.isPending} aria-label="Playlist recipe">
      <div className="builder-columns">
        <section className="builder-section">
          <div className="builder-line">
            <h2>Seed songs</h2>
            <span>
              {seedTrackIds.length} / {MAX_PICKS}
            </span>
          </div>
          <p className="builder-hint">
            Pick up to five songs by {artist.name} to keep in your mix.
          </p>
          {options.data.tracks.length > 8 && (
            <input
              className="input"
              type="search"
              placeholder="Filter songs"
              aria-label="Filter seed songs"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <ul className="builder-list builder-list--scroll" aria-label="Seed songs">
            {matchingTracks.map((track) => {
              const selected = seedTrackIds.includes(track.id);
              return (
                <li key={track.id}>
                  <button
                    className="builder-row"
                    type="button"
                    aria-pressed={selected}
                    disabled={!selected && seedTrackIds.length >= MAX_PICKS}
                    onClick={() =>
                      setSelectedSeeds((ids) =>
                        selected
                          ? ids.filter((id) => id !== track.id)
                          : [...seedTrackIds, track.id],
                      )
                    }
                  >
                    <Music aria-hidden="true" />
                    <span className="builder-row__copy">
                      <strong>{track.trackName}</strong>
                      {track.albumName && <small>{track.albumName}</small>}
                    </span>
                    {selected ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {!matchingTracks.length && (
            <p className="builder-hint" role="status">
              {filter ? "No songs match your filter." : "No seed songs available for this artist."}
            </p>
          )}
        </section>
        <section className="builder-section">
          <div className="builder-line">
            <h2>Similar artists</h2>
            <span>
              {similarArtists.length} / {MAX_PICKS}
            </span>
          </div>
          <p className="builder-hint">Choose up to five more artists to include.</p>
          {similarArtists.length > 0 && (
            <div className="builder-chips">
              {similarArtists.map((item) => (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  key={artistKey(item)}
                  aria-label={`Remove ${item.name}`}
                  onClick={() => toggleArtist(item)}
                >
                  {item.name}
                  <X aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          {similarArtists.length < MAX_PICKS && (
            <>
              <BuilderArtistSearch
                label="Find another artist"
                recommendationMode={recommendationMode}
                source={source}
                exclude={[artist, ...similarArtists]}
                onPick={toggleArtist}
              />
              {suggestions.length > 0 && (
                <div className="builder-field">
                  <span className="artist-field-label">Suggested artists</span>
                  <div className="builder-chips">
                    {suggestions.map((item) => (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        key={artistKey(item)}
                        onClick={() => toggleArtist(item)}
                      >
                        <Plus aria-hidden="true" />
                        {item.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <div className="builder-field">
        <label className="artist-field-label" htmlFor="builder-size">
          Number of songs
        </label>
        <input
          type="number"
          inputMode="numeric"
          id="builder-size"
          className="input builder-count"
          min={minSize}
          max={100}
          step={1}
          value={sizeInput}
          onChange={(event) => setSizeInput(event.target.value)}
        />
        {!validSize && (
          <p className="builder-hint" role="status">
            Choose a whole number from {minSize} to 100.
          </p>
        )}
      </div>
      {exploreFurther && (
        <details className="builder-advanced">
          <summary>Advanced</summary>
          <div className="builder-field">
            <div className="builder-chips">
              <span className="artist-field-label" id="builder-max-hops">
                Max hops
              </span>
              <TooltipButton
                className="btn btn-ghost btn-icon"
                label="About max hops"
                aria-expanded={showHopHelp}
                aria-controls="builder-max-hops-help"
                onClick={() => setShowHopHelp((open) => !open)}
              >
                <Info aria-hidden="true" />
              </TooltipButton>
            </div>
            <p id="builder-max-hops-help" className="builder-hint" hidden={!showHopHelp}>
              One hop checks for songs like your seed songs. Two hops also check for songs like
              those matches. Three hops follow those matches one step further.
            </p>
            <div className="artist-segmented" role="radiogroup" aria-labelledby="builder-max-hops">
              {HOP_OPTIONS.map(({ value, label }) => (
                <label
                  key={value}
                  className={`artist-segmented-button${maxHops === value ? " is-active" : ""}`}
                >
                  <input
                    type="radio"
                    className="artist-checkbox"
                    name="builder-max-hops"
                    value={value}
                    checked={maxHops === value}
                    onChange={() => setMaxHops(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </details>
      )}
      {preview.error && (
        <p className="artist-error-text" role="alert">
          {getApiErrorMessage(preview.error, "Couldn't build playlist preview")}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!validSize || preview.isPending}
        onClick={() => preview.mutate(undefined, { onSuccess: onReview })}
      >
        {preview.isPending ? <DotLoader label={null} /> : <ListMusic aria-hidden="true" />}
        {preview.isPending ? "Building preview…" : "Preview playlist"}
      </button>
    </fieldset>
  );
}

export default function PlaylistBuilderPage() {
  useDocumentTitle("Playlist builder");
  const busy = useIsMutating({ mutationKey: builderActionKey }) > 0;
  const { bootstrap } = useAuth();
  const enhanced = bootstrap?.api?.features?.includes("playlistBuilderRecommendations") ?? false;
  const [online, setOnline] = useState(true);
  const recommendationMode = enhanced ? (online ? "online" : "offline") : undefined;
  const [review, setReview] = useState<BuilderReview | null>(null);
  const [source, setSource] = useState<BuilderSource>("library");
  const [artist, setArtist] = useState<BuilderArtist | null>(null);
  return (
    <div className="library-page native-library-page playlist-page">
      <header className="native-library-header">
        <h1 className="page-title">Playlist builder</h1>
        <p className="builder-intro">
          Start with an artist, pick a few songs, and preview your mix.
        </p>
      </header>
      <fieldset className="builder-body" disabled={busy} aria-label="Playlist builder">
        <div className="builder-controls">
          <div className="builder-field">
            <span id="builder-source" className="artist-field-label">
              Track source
            </span>
            <div className="artist-segmented" role="group" aria-labelledby="builder-source">
              {SOURCES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={`artist-segmented-button${source === value ? " is-active" : ""}`}
                  aria-pressed={source === value}
                  onClick={() => {
                    if (source !== value) {
                      setReview(null);
                      setSource(value);
                    }
                  }}
                >
                  <Icon aria-hidden="true" />
                  {enhanced ? label : value === "library" ? "Library only" : label}
                </button>
              ))}
            </div>
            {enhanced && (
              <div className="builder-mode">
                <div className="builder-line">
                  <label className="artist-field-label" htmlFor="builder-online">
                    Online recommendations
                  </label>
                  <PillToggle
                    id="builder-online"
                    aria-label="Online recommendations"
                    checked={online}
                    onChange={({ target }) => {
                      setReview(null);
                      setOnline(target.checked);
                    }}
                  />
                </div>
                <p className="builder-hint">
                  {online
                    ? source === "library"
                      ? "Find matches online and fill the mix with music you already own."
                      : "Look online for matches across your Library and the catalog."
                    : source === "library"
                      ? "Fully local. Use your files and cached recommendations."
                      : "Use your Library and cached catalog suggestions."}
                </p>
              </div>
            )}
          </div>
          {artist ? (
            <div className="builder-field">
              <span className="artist-field-label">Main artist</span>
              <div className="builder-line builder-artist">
                <div className="builder-identity">
                  <ArtistImage
                    key={artistKey(artist)}
                    artistName={artist.name}
                    alt={artist.name}
                    className="builder-avatar"
                    sizes="3.25rem"
                    mbid={
                      source === "discovery" && recommendationMode !== "offline"
                        ? artist.mbid
                        : null
                    }
                    src={
                      artist.libraryArtistId &&
                      (source === "library" || recommendationMode === "offline" || !artist.mbid)
                        ? buildAuthenticatedApiUrl(
                            `/library/artists/${artist.libraryArtistId}/cover`,
                            { cachedOnly: 1 },
                          )
                        : null
                    }
                  />
                  <strong>{artist.name}</strong>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setArtist(null);
                    setReview(null);
                  }}
                >
                  Change artist
                </button>
              </div>
            </div>
          ) : (
            <BuilderArtistSearch
              key={source}
              label="Main artist"
              source={source}
              recommendationMode={recommendationMode}
              exclude={[]}
              onPick={setArtist}
            />
          )}
        </div>
        {artist && (
          <BuilderRecipe
            key={artistKey(artist)}
            source={source}
            artist={artist}
            recommendationMode={recommendationMode}
            review={review}
            onEdit={() => setReview(null)}
            onReview={(next) => {
              setReview(next);
              setSource(next.recipe.source);
              setOnline(next.recipe.recommendationMode !== "offline");
            }}
          />
        )}
      </fieldset>
    </div>
  );
}

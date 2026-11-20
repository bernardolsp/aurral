import { useState } from "react";
import { useNavigate } from "react-router";
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type {
  BuilderArtist,
  BuilderSource,
  BuilderTrack,
} from "../../../../backend/routes/playlists/builderSchema.ts";
import ArtistImage from "../../components/ArtistImage";
import { asApiError, buildAuthenticatedApiUrl } from "../../utils/api/core.ts";
import { DotLoader } from "../../components/DotLoader";
import { Check, Compass, Library, ListMusic, Music, Pencil, Plus, X } from "../../components/icons";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { playlistPath } from "../../navigation/playlistPaths";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { playlistBuilderClient } from "../../utils/api/clients/playlistBuilder.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import {
  artistKey,
  BuilderArtistSearch,
  BuilderLoading,
  BuilderLookupError,
} from "./BuilderArtistSearch";
import "./playlistBuilder.css";

const MAX_PICKS = 5;
const formatArtists = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const SAVE_KEY = ["playlist-builder", "save"];
const focusHeading = (node: HTMLHeadingElement | null) => node?.focus();
const SOURCES = [
  { value: "library", label: "Library only", icon: Library },
  { value: "discovery", label: "Library + discovery", icon: Compass },
] as const;

function BuilderPreview({
  tracks,
  missingArtists,
  artist,
  source,
  size,
  onEdit,
}: {
  tracks: BuilderTrack[];
  missingArtists: string[];
  artist: BuilderArtist;
  source: BuilderSource;
  size: number;
  onEdit: () => void;
}) {
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const [name, setName] = useState(`${artist.name} mix`.slice(0, 500));
  const [omitted, setOmitted] = useState<string[]>([]);
  const selected = tracks.filter((track) => !omitted.includes(track.id));
  const remoteCount = selected.filter((track) => track.source === "discovery").length;
  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: () =>
      parseResponse(
        playlistBuilderClient.save.$post({ json: { source, name: name.trim(), tracks: selected } }),
      ),
  });

  return (
    <section className="builder-section" aria-labelledby="builder-preview">
      <div className="builder-line">
        <h2 id="builder-preview" tabIndex={-1} ref={focusHeading}>
          Playlist preview
        </h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onEdit}
          disabled={save.isPending}
        >
          <Pencil aria-hidden="true" />
          Edit mix
        </button>
      </div>
      <p className="builder-hint" role="status">
        {tracks.length
          ? `${selected.length} of ${tracks.length} tracks selected`
          : "No tracks matched. Edit your mix to try other artists or a different source."}
        {tracks.length > 0 &&
          tracks.length < size &&
          ` · Found ${tracks.length} of ${size} requested`}
      </p>
      {missingArtists.length > 0 && (
        <p className="builder-hint">
          No matching tracks for {formatArtists.format(missingArtists)}.
        </p>
      )}
      {tracks.length > 0 && (
        <>
          <form
            className="builder-save"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || !selected.length || save.isPending) return;
              save.mutate(undefined, {
                onSuccess: ({ playlistId }) => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.playlistStatus });
                  showSuccess(`Queued creation of ${name.trim()}`);
                  navigate(playlistPath(playlistId), { replace: true, state: { created: true } });
                },
              });
            }}
          >
            <label className="artist-field-label" htmlFor="builder-name">
              Playlist name
            </label>
            <div className="builder-save__actions">
              <input
                className="input input--tall"
                id="builder-name"
                maxLength={500}
                required
                value={name}
                disabled={save.isPending}
                onChange={(event) => {
                  setName(event.target.value);
                  if (save.error) save.reset();
                }}
              />
              <button
                className="btn btn-primary"
                type="submit"
                disabled={!name.trim() || !selected.length || save.isPending}
              >
                {save.isPending ? <DotLoader label={null} /> : <ListMusic aria-hidden="true" />}Save
                playlist
              </button>
            </div>
            {save.error && (
              <p className="artist-error-text" role="alert">
                {getApiErrorMessage(save.error, "Couldn't save playlist")}
              </p>
            )}
            {remoteCount > 0 && (
              <p className="builder-hint">
                {remoteCount} catalog {remoteCount === 1 ? "track can" : "tracks can"} be downloaded
                from the saved playlist.
              </p>
            )}
          </form>
          <ol className="builder-list" aria-label="Playlist preview tracks">
            {tracks.map((track, index) => (
              <li key={track.id}>
                <label className="builder-row builder-row--preview">
                  <span className="builder-row__number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="builder-row__copy">
                    <strong>{track.trackName}</strong>
                    <small>{track.artistName}</small>
                  </span>
                  {source === "discovery" && (
                    <small>{track.source === "library" ? "Library" : "Catalog"}</small>
                  )}
                  <input
                    type="checkbox"
                    className="artist-checkbox"
                    aria-label={`Include ${track.trackName} by ${track.artistName}`}
                    checked={!omitted.includes(track.id)}
                    onChange={(event) => {
                      const include = event.target.checked;
                      setOmitted((ids) =>
                        include ? ids.filter((id) => id !== track.id) : [...ids, track.id],
                      );
                    }}
                  />
                </label>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function BuilderRecipe({ artist, source }: { artist: BuilderArtist; source: BuilderSource }) {
  const [seedTrackIds, setSeedTrackIds] = useState<string[]>([]);
  const [similarArtists, setSimilarArtists] = useState<BuilderArtist[]>([]);
  const [sizeInput, setSizeInput] = useState("20");
  const [filter, setFilter] = useState("");
  const options = useQuery({
    queryKey: ["playlist-builder", "options", source, artist],
    queryFn: ({ signal }) =>
      parseResponse(
        playlistBuilderClient.options.$post({ json: { source, artist } }, { init: { signal } }),
      ),
  });
  const size = Number(sizeInput);
  const minSize = Math.max(1, seedTrackIds.length) + similarArtists.length;
  const validSize = Number.isInteger(size) && size >= minSize && size <= 100;
  const preview = useMutation({
    mutationFn: () =>
      parseResponse(
        playlistBuilderClient.preview.$post({
          json: { source, artist, seedTrackIds, similarArtists, size },
        }),
      ),
    onError: async (error) => {
      if (asApiError(error)?.response?.status !== 409) return;
      const refreshed = await options.refetch();
      if (refreshed.isSuccess) {
        const available = new Set(refreshed.data.tracks.map((track) => track.id));
        setSeedTrackIds((ids) => ids.filter((id) => available.has(id)));
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
  if (options.isPending) return <BuilderLoading label={`Loading tracks for ${artist.name}`} />;
  if (options.isError)
    return (
      <BuilderLookupError
        error={options.error}
        label="Couldn't load tracks and similar artists"
        onRetry={() => void options.refetch()}
      />
    );
  if (preview.data)
    return (
      <BuilderPreview
        artist={artist}
        tracks={preview.data.tracks}
        missingArtists={preview.data.missingArtists}
        size={size}
        source={source}
        onEdit={preview.reset}
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
                      setSeedTrackIds((ids) =>
                        selected ? ids.filter((id) => id !== track.id) : [...ids, track.id],
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
      {preview.error && (
        <p className="artist-error-text" role="alert">
          {getApiErrorMessage(preview.error, "Couldn't build playlist preview")}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!validSize || preview.isPending}
        onClick={() => preview.mutate()}
      >
        {preview.isPending ? <DotLoader label={null} /> : <ListMusic aria-hidden="true" />}
        {preview.isPending ? "Building preview…" : "Preview playlist"}
      </button>
    </fieldset>
  );
}

export default function PlaylistBuilderPage() {
  useDocumentTitle("Playlist builder");
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;
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
      <fieldset className="builder-body" disabled={saving} aria-label="Playlist builder">
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
                      setArtist(null);
                      setSource(value);
                    }
                  }}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
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
                    mbid={source === "discovery" ? artist.mbid : null}
                    src={
                      artist.libraryArtistId && (source === "library" || !artist.mbid)
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
                  onClick={() => setArtist(null)}
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
              exclude={[]}
              onPick={setArtist}
            />
          )}
        </div>
        {artist && <BuilderRecipe key={artistKey(artist)} source={source} artist={artist} />}
      </fieldset>
    </div>
  );
}

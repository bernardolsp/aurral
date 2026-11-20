import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Compass, ListMusic, Pencil, Plus } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { useToast } from "../../contexts/ToastContext";
import { playlistPath } from "../../navigation/playlistPaths";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  builderActionKey,
  fetchBuilderPreview,
  playlistBuilderClient,
  type BuilderReview,
} from "../../utils/api/clients/playlistBuilder.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";

const formatArtists = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const focusHeading = (node: HTMLHeadingElement | null) => node?.focus();
const REASONS = {
  seed: "Your seed song",
  recording: "Similar to a seed song",
  chosenArtist: "An artist you picked",
  relatedArtist: "Related artist",
  genre: "Shared genre",
};

export function BuilderPreview({
  review,
  onEdit,
  onExpand,
}: {
  review: BuilderReview;
  onEdit: () => void;
  onExpand: (expanded: BuilderReview) => void;
}) {
  const { artist, source, size, recommendationMode } = review.recipe;
  const { tracks, missingArtists } = review.result;
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const [name, setName] = useState(`${artist.name} mix`.slice(0, 500));
  const [omitted, setOmitted] = useState<string[]>([]);
  const selected = tracks.filter((track) => !omitted.includes(track.id));
  const remoteCount = selected.filter((track) => track.source === "discovery").length;
  const save = useMutation({
    mutationKey: builderActionKey,
    mutationFn: () =>
      parseResponse(
        playlistBuilderClient.save.$post({
          json: { source, recommendationMode, name: name.trim(), tracks: selected },
        }),
      ),
  });

  const check = useMutation({
    mutationFn: () => fetchBuilderPreview({ ...review.recipe, recommendationMode: "online" }),
  });
  const expand = useMutation({
    mutationKey: builderActionKey,
    mutationFn: () =>
      fetchBuilderPreview({
        ...review.recipe,
        source: "discovery",
        recommendationMode: check.data ? "online" : recommendationMode,
      }),
  });
  const discoveries = (check.data ?? review).result.discoveryTeaser ?? [];
  const canCheck = source === "library" && recommendationMode === "offline" && !check.data;

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
      {review.result.recommendationBasis && (
        <p className="builder-hint">
          {review.result.recommendationBasis === "recording"
            ? "Matched using your seed songs."
            : "Matched using your artist choices."}
        </p>
      )}
      {source === "library" && recommendationMode && (
        <aside className="builder-discoveries" aria-label="Discovery suggestions">
          <h3>
            <Compass aria-hidden="true" />
            Discovery could add
          </h3>
          {discoveries.length > 0 ? (
            <ul className="builder-list">
              {discoveries.map((track) => (
                <li key={track.id}>
                  <strong>{track.trackName}</strong> · {track.artistName}
                </li>
              ))}
            </ul>
          ) : (
            <p className="builder-hint">
              {canCheck
                ? "Check online for songs beyond your Library."
                : "No additional tracks found for this mix."}
            </p>
          )}
          <div className="builder-chips">
            {canCheck && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending && <DotLoader label={null} />}
                {check.isPending ? "Checking Discovery…" : "Check Discovery"}
              </button>
            )}
            {discoveries.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={check.isPending || expand.isPending}
                onClick={() => expand.mutate(undefined, { onSuccess: onExpand })}
              >
                {expand.isPending ? <DotLoader label={null} /> : <Plus aria-hidden="true" />}
                Include discoveries
              </button>
            )}
          </div>
          {canCheck && discoveries.length > 0 && (
            <p className="builder-hint">
              These suggestions are cached. Check Discovery to look online once.
            </p>
          )}
          {check.data && (
            <p className="builder-hint">
              Checked online once.
              {discoveries.length > 0 && " Including discoveries uses online recommendations."}
            </p>
          )}
          {(check.error || expand.error) && (
            <p className="artist-error-text" role="alert">
              {getApiErrorMessage(
                expand.error ?? check.error,
                "Couldn't check Discovery. Try again.",
              )}
            </p>
          )}
        </aside>
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
            {source === "discovery" && recommendationMode && (
              <p className="builder-hint" role="status">
                {selected.length - remoteCount} in your Library · {remoteCount} from the catalog
              </p>
            )}
            {remoteCount > 0 && (
              <p className="builder-hint">
                You can download catalog tracks from the saved playlist.
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
                    <small>
                      {track.artistName}
                      {track.pickReason && ` · ${REASONS[track.pickReason]}`}
                    </small>
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

// Lyrics for listeners, and the operator's per-track timing fix.
//
//   GET /lyrics/current            public (station-gated on a private station),
//                                  behind settings.lyrics.enabled
//   PUT /lyrics/offsets/:trackId   admin; the station-wide correction
//
// The read answers for the track the LISTENER hears, which is a stream buffer
// behind the live edge: a player names it with `?songId=`, and the route
// accepts the on-air track or one of the few just before it. Answering only for
// the live edge left a player opened in a song's last `bufferSeconds` asking
// about a track the live edge had already left, which no retry could fix.
import express from 'express';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import * as subsonic from '../music/subsonic.js';
import { resolveSilenceTrim } from '../music/silence-trim.js';
import { toPublicLyricsPayload, type StructuredLyricsInput } from '../music/lyrics-public.js';
import { BoundedLyricsCache } from '../music/lyrics-cache.js';
import { requireAdmin } from '../middleware/auth.js';
import { requireStationAuth } from '../middleware/station-auth.js';
import { validateBody } from '../middleware/validate.js';
import { lyricOffsetBodySchema, lyricsQuerySchema, lyricsTrackIdSchema } from '../schemas/lyrics.js';

export const router = express.Router();

// Plays a listener can still be hearing besides the one on air. The player
// caps its buffer offset at 60s, and a track shorter than that can pass inside
// it, so one is not enough. Every one of them is already public on GET /state.
export const RECENT_PLAYS = 3;

// How long a player should wait after the music server failed to answer.
// Matches the cache's negative TTL, inside which a retry would only be told
// the same thing.
export const LYRICS_RETRY_AFTER_SEC = 10;

const lyricCache = new BoundedLyricsCache<StructuredLyricsInput>({
  negativeTtlMs: LYRICS_RETRY_AFTER_SEC * 1000,
});

interface PlayRecord {
  track?: { id?: string | null } | null;
  cueInSec?: number;
  source?: string;
}

// The play `songId` names among those a listener can be hearing: the queue's
// record of it (null when it is on air with no record yet), or undefined when
// it is none of them.
export function heardPlay(
  songId: string,
  onAirId: string | null,
  current: PlayRecord | null,
  history: readonly PlayRecord[],
): PlayRecord | null | undefined {
  if (songId === onAirId) return current?.track?.id === songId ? current : null;
  return history.slice(0, RECENT_PLAYS).find((p) => p?.track?.id === songId);
}

// Where in the file this play began. A drained play carries the cue the queue
// stamped on it, which is the one Liquidsoap got (a stem seam can move it past
// the trim's own); the auto playlist stamps the trim policy's cue and keeps no
// record of it, so that is asked again, as /now-playing does.
function cueInFor(play: PlayRecord | null, songId: string): number | null {
  if (play && play.source !== 'auto') return play.cueInSec ?? null;
  return resolveSilenceTrim(library.get(songId)).cueInSec;
}

async function lyricsEnabled(_req: express.Request, res: express.Response, next: express.NextFunction) {
  await settings.load();
  if (settings.get()?.lyrics?.enabled === true) return next();
  res.status(403).json({ error: 'Lyrics are switched off on this station', enabled: false });
}

router.get('/lyrics/current', lyricsEnabled, requireStationAuth, async (req, res) => {
  const query = lyricsQuerySchema.safeParse(req.query ?? {});
  if (!query.success) return res.status(400).json({ error: 'songId must be a track id' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const nowPlaying = await queue.getNowPlaying();
    const onAirId = nowPlaying?.subsonic_id ? String(nowPlaying.subsonic_id) : null;
    const songId = query.data.songId ?? onAirId;
    if (!songId) return res.json(toPublicLyricsPayload(null, null));

    const play = heardPlay(songId, onAirId, queue.current, queue.history);
    if (play === undefined) {
      return res.status(409).json({ error: 'That track is no longer on air', songId: onAirId });
    }

    let lyrics: StructuredLyricsInput | null;
    try {
      lyrics = await lyricCache.get(songId, () => subsonic.fetchStructuredLyrics(songId));
    } catch {
      // Not "no lyrics": the server did not answer, and the player must say so
      // and ask again rather than tell the listener the library has none.
      res.setHeader('Retry-After', String(LYRICS_RETRY_AFTER_SEC));
      return res.status(503).json({
        error: 'The music server did not answer for lyrics',
        retryAfter: LYRICS_RETRY_AFTER_SEC,
      });
    }

    const offsetMs = await library.getLyricOffset(songId);
    res.json(toPublicLyricsPayload(songId, lyrics, { offsetMs, cueInSec: cueInFor(play, songId) }));
  } catch (err) {
    queue.log('error', `/lyrics/current failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'internal error' });
  }
});

router.put('/lyrics/offsets/:trackId', requireAdmin, validateBody(lyricOffsetBodySchema), async (req, res) => {
  const trackId = lyricsTrackIdSchema.safeParse(req.params.trackId);
  if (!trackId.success) return res.status(400).json({ error: 'trackId must be a track id' });
  try {
    const { offsetMs } = req.body as { offsetMs: number };
    await library.setLyricOffset(trackId.data, offsetMs);
    res.json({ ok: true, trackId: trackId.data, offsetMs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not save the offset' });
  }
});

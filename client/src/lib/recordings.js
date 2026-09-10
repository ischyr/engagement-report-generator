/**
 * Screen recordings as evidence, and the still frame that stands in for them.
 *
 * Some findings are not a screenshot. A race condition, a click-through that only works in a
 * particular order, an interface that misbehaves while it animates — the evidence for those is
 * thirty seconds of video, and until now that went into a chat message and died there.
 *
 * A document cannot hold a video, so every recording is stored with a **still frame** taken out of
 * it, and the still is what goes into the prose, gets numbered as a figure and prints in the
 * report. The recording sits behind it for anybody reviewing the evidence in the app.
 *
 * The frame is taken **here, in the browser**, for the same three reasons the screenshot shrinking
 * is done here (see `images.js`): the browser already has a decoder for everything it will accept,
 * the alternative is a video decoder in a reporting tool's dependency list, and the person who
 * dropped the file is still standing there if it cannot be read.
 *
 * That last point is also the check. If this cannot produce a frame, the browser cannot play the
 * file either — so the upload is refused rather than storing a recording nobody can watch and
 * nothing can illustrate.
 */

/**
 * The two formats, and deliberately only two.
 *
 * MP4 and WebM are what every browser can both decode and play. A QuickTime `.mov` off a Mac is
 * usually H.264 inside and *sometimes* plays, which is worse than refusing it: evidence that works
 * on the machine it was captured on and nowhere else is not evidence.
 */
export const ACCEPTED_RECORDING_TYPES = ['video/mp4', 'video/webm'];

export const isRecording = (file) =>
  ACCEPTED_RECORDING_TYPES.includes(String(file?.type ?? '').toLowerCase());

/** The still is a picture in a report, so it gets the same ceiling every screenshot gets. */
const MAX_POSTER_EDGE = 1600;

/** How long to wait for a browser to decode enough of a file to draw one frame. */
const DECODE_TIMEOUT_MS = 15000;

/**
 * Where in the recording to take the frame from.
 *
 * Not the first frame. A screen capture almost always opens on a blank window, a fade, or the
 * moment before the recorder got out of the way — so frame zero is a black rectangle in the report
 * where the evidence should be. A tenth of the way in is past all of that and still the beginning
 * of what the recording is about, capped so a five-minute capture does not open two-thirds of a
 * minute in.
 */
export function posterTime(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(duration * 0.1, 0.05), 2, Math.max(duration - 0.05, 0));
}

/** Longest edge down to what a page can print, keeping the shape. */
export function posterSize(width, height, maxEdge = MAX_POSTER_EDGE) {
  const longest = Math.max(width, height);
  if (!longest) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / longest);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const canDecode = () => typeof document !== 'undefined' && typeof URL?.createObjectURL === 'function';

/**
 * One frame out of a recording, as a PNG file ready to upload.
 *
 * Never throws: a null return means this browser could not read the file, which the caller turns
 * into a refusal with something useful to say.
 *
 * @param {File|Blob} file
 * @returns {Promise<{file: File, width: number, height: number, seconds: number}|null>}
 */
export async function posterFromRecording(file) {
  if (!file || !canDecode()) return null;

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  /* Muted and inline, or a browser may refuse to load the media at all without a gesture. */
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    const drawn = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), DECODE_TIMEOUT_MS);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };

      video.onerror = () => done(null);

      /*
       * Two steps: wait for the metadata to know how long it is, seek, then wait to be told the
       * frame at that position is actually available. Drawing on `loadeddata` alone gives you
       * whatever was decoded first, which is the black opening frame this seek exists to avoid.
       */
      video.onloadedmetadata = () => {
        const seconds = posterTime(video.duration);
        video.onseeked = () => {
          const { width, height } = posterSize(video.videoWidth, video.videoHeight);
          if (!width || !height) return done(null);

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) return done(null);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          try {
            context.drawImage(video, 0, 0, width, height);
          } catch {
            return done(null);
          }
          return canvas.toBlob(
            (blob) => done(blob ? { blob, width, height, seconds: video.duration } : null),
            'image/png'
          );
        };
        /* A zero-length or unseekable file: take whatever the first frame is rather than nothing. */
        if (seconds <= 0) video.onseeked();
        else video.currentTime = seconds;
      };
    });

    if (!drawn) return null;

    const base = String(file.name ?? 'recording').replace(/\.[^.]+$/, '') || 'recording';
    return {
      file: new File([drawn.blob], `${base}.png`, { type: 'image/png', lastModified: Date.now() }),
      width: drawn.width,
      height: drawn.height,
      seconds: Number.isFinite(drawn.seconds) ? drawn.seconds : 0,
    };
  } finally {
    /* Both, always: a video element left holding a blob URL keeps the whole file in memory. */
    video.removeAttribute('src');
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

/** "0:34", for a badge on a still. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default { isRecording, posterFromRecording, posterTime, posterSize, formatDuration };

/**
 * Pictures on the way into a message.
 *
 * Paste a screenshot, drop a file. Both arrive as a `File` and both
 * have to become base64 before they can go anywhere, which is the
 * whole of this file — that and the two limits, which matter more
 * than the conversion.
 *
 * ## Why there are limits at all
 *
 * An image is the one thing in a conversation that cannot be
 * trimmed. A long tool result can be re-run with `| tail -50`; a
 * screenshot is the size it is for the rest of the session, re-sent
 * on every turn, and no amount of compaction touches it — compaction
 * summarises *text*.
 *
 * So: a cap per image, and a cap per message. Both are refusals with
 * a sentence rather than silent downscaling, because a window that
 * quietly resamples somebody's screenshot and then cannot read the
 * stack trace in it has helped nobody.
 */

import type { AgentImage } from "./figycode-agent";

/** What a provider will take, and what a conversation can carry. */
export const MAX_BYTES = 4 * 1024 * 1024;

/** Four is a comparison; ten is a gallery nobody will read. */
export const MAX_IMAGES = 4;

/**
 * The formats every vision model takes.
 *
 * Deliberately short. A TIFF or a BMP pasted from an old tool is
 * better refused here than sent and refused by the provider, where
 * the error arrives as a failed turn.
 */
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** One attached picture, before it is sent. */
export interface Attachment extends AgentImage {
  /** Stable for the life of the attachment: a React key, and what
      removing one names. */
  id: string;
  /** What to call it in the chip. A pasted image has no filename. */
  name: string;
  bytes: number;
  /** For the thumbnail. The whole data URL, built once here rather
      than re-assembled on every render. */
  url: string;
}

export function isImage(file: File): boolean {
  return ACCEPTED.includes(file.type);
}

/** `184 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Turns dropped or pasted files into attachments, and says what it
 * refused.
 *
 * Refusals come back as sentences rather than being thrown, because
 * three files where one is a PDF should attach the two and mention
 * the third — not fail the whole drop.
 */
export async function attach(
  files: File[],
  already: Attachment[]
): Promise<{ added: Attachment[]; refused: string[] }> {
  const added: Attachment[] = [];
  const refused: string[] = [];
  let room = MAX_IMAGES - already.length;

  for (const file of files) {
    const name = file.name || "pasted image";
    if (!isImage(file)) {
      refused.push(`${name} is ${file.type || "not an image"}`);
      continue;
    }
    if (file.size > MAX_BYTES) {
      refused.push(`${name} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_BYTES)} limit`);
      continue;
    }
    if (room <= 0) {
      refused.push(`${name} — ${MAX_IMAGES} images is the most one message carries`);
      continue;
    }

    try {
      const data = await base64(file);
      added.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        mime: file.type,
        data,
        bytes: file.size,
        url: `data:${file.type};base64,${data}`,
      });
      room -= 1;
    } catch {
      refused.push(`${name} could not be read`);
    }
  }
  return { added, refused };
}

/**
 * The base64 of a file, without the `data:` prefix.
 *
 * The prefix is left off rather than cut off: the backend builds its
 * own when it serialises, and keeping ours would put sixty bytes of
 * ceremony in the conversation, in the saved snapshot and in every
 * later request.
 *
 * `arrayBuffer` and `btoa` rather than `FileReader`, which was the
 * first version and is a DOM API — so the tests could not run a
 * single line of this, and the limits that matter most went
 * unchecked. These two exist in both the webview and in Node.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a four-megabyte
 * screenshot is four million arguments and a stack overflow.
 */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

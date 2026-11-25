/**
 * Pictures on the way into a message.
 *
 * The limits are the part worth testing. An image is the one thing
 * in a conversation that cannot be trimmed — a long tool result can
 * be re-run with `| tail -50`, and a screenshot is the size it is
 * for the rest of the session, re-sent on every turn, untouched by
 * compaction, which summarises text.
 *
 * So what is checked here is mostly what is *refused*, and that a
 * refusal is partial: three files where one is a PDF should attach
 * the two and mention the third.
 */

import assert from "node:assert/strict";
import { MAX_BYTES, MAX_IMAGES, attach, formatBytes, isImage } from "./figycode-attach";

let failures = 0;
function test(name: string, run: () => void | Promise<void>) {
  const done = () => console.log(`  ok  ${name}`);
  try {
    const out = run();
    if (out instanceof Promise) {
      return out.then(done, (error: Error) => {
        failures++;
        console.error(`  FAIL  ${name}\n        ${error.message}`);
      });
    }
    done();
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${name}\n        ${(error as Error).message}`);
  }
  return Promise.resolve();
}

console.log("figycode-attach");

/** A `File` of a given type and size, without touching the disk. */
function file(name: string, type: string, bytes = 32): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

await test("the formats every vision model takes, and no others", () => {
  assert.equal(isImage(file("a.png", "image/png")), true);
  assert.equal(isImage(file("a.jpg", "image/jpeg")), true);
  assert.equal(isImage(file("a.webp", "image/webp")), true);
  // Refused here rather than by the provider, where it arrives as a
  // failed turn with the message already spent.
  assert.equal(isImage(file("a.tiff", "image/tiff")), false);
  assert.equal(isImage(file("notes.pdf", "application/pdf")), false);
});

await test("a file becomes base64 with no data: prefix on it", async () => {
  const { added, refused } = await attach([file("shot.png", "image/png", 3)], []);
  assert.equal(refused.length, 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].mime, "image/png");
  // The backend builds the prefix when it serialises; storing ours
  // would put it in the conversation and in every later request.
  assert.ok(!added[0].data.startsWith("data:"), added[0].data.slice(0, 12));
  assert.equal(added[0].url, `data:image/png;base64,${added[0].data}`);
  assert.equal(added[0].bytes, 3);
});

await test("one bad file does not fail the whole drop", async () => {
  const { added, refused } = await attach(
    [file("a.png", "image/png"), file("notes.pdf", "application/pdf"), file("b.png", "image/png")],
    []
  );
  assert.equal(added.length, 2, "the two images attach");
  assert.equal(refused.length, 1);
  assert.ok(refused[0].includes("notes.pdf"), refused[0]);
});

await test("an image too large to carry is refused with its size", async () => {
  const { added, refused } = await attach([file("huge.png", "image/png", MAX_BYTES + 1)], []);
  assert.equal(added.length, 0);
  assert.ok(refused[0].includes("huge.png"));
  assert.ok(refused[0].includes("4.0 MB"), refused[0]);
});

await test("the cap counts what is already attached, not just this drop", async () => {
  const already = (await attach([file("a.png", "image/png")], [])).added;
  const rest = Array.from({ length: MAX_IMAGES }, (_, i) => file(`b${i}.png`, "image/png"));

  const { added, refused } = await attach(rest, already);
  assert.equal(added.length, MAX_IMAGES - 1, "room for one fewer");
  assert.equal(refused.length, 1);
  assert.ok(refused[0].includes(`${MAX_IMAGES} images`), refused[0]);
});

await test("sizes read as sizes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(184 * 1024), "184 KB");
  assert.equal(formatBytes(2.5 * 1024 * 1024), "2.5 MB");
});

process.exit(failures ? 1 : 0);

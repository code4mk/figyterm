/**
 * Which window is in front, and — the part that was broken — how high it is
 * allowed to climb while getting there.
 *
 * The z-index used to be the claim counter itself, and a claim is made on every
 * pointer-down rather than once per window. So the number grew without limit
 * and eventually overtook the fixed z-indexes the app's own dialogs hold:
 * Settings opened behind the editor, and the new-window prompt behind whatever
 * window you had been clicking on. Nothing failed; the dialog just was not
 * where you were looking.
 */

import assert from "node:assert/strict";
import {
  APP_DIALOG_Z,
  claimFront,
  isCovered,
  isFront,
  overlayZ,
  OVERLAY_Z_MAX,
  releaseFront,
  setOverlayRect,
} from "./overlay-stack";

let failures = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(error as Error).message.split("\n").join("\n        ")}`);
  }
}

/** The module is a singleton, so each test clears up after itself. */
function reset(...ids: string[]) {
  for (const id of ids) releaseFront(id);
}

console.log("overlay-stack");

test("the most recently claimed overlay is in front", () => {
  claimFront("editor");
  claimFront("browser");
  assert.ok(overlayZ("browser")! > overlayZ("editor")!);

  claimFront("editor");
  assert.ok(overlayZ("editor")! > overlayZ("browser")!);
  reset("editor", "browser");
});

test("clicking between two windows does not climb", () => {
  // The regression, stated as a test: a thousand claims used to mean a z-index
  // of a thousand-odd, and every fixed number in the app was below it.
  claimFront("editor");
  claimFront("browser");
  for (let i = 0; i < 1000; i++) {
    claimFront(i % 2 === 0 ? "editor" : "browser");
  }

  assert.ok(
    overlayZ("editor")! <= OVERLAY_Z_MAX,
    `editor climbed to ${overlayZ("editor")}`
  );
  assert.ok(
    overlayZ("browser")! <= OVERLAY_Z_MAX,
    `browser climbed to ${overlayZ("browser")}`
  );
  // And the ordering still works after all that.
  assert.ok(overlayZ("browser")! > overlayZ("editor")!);
  reset("editor", "browser");
});

test("an app dialog outranks every overlay, however many are open", () => {
  const ids = ["editor", "browser", "drawing", "claude", "api", "monitor", "history"];
  for (const id of ids) claimFront(id);
  for (const id of ids) {
    assert.ok(
      overlayZ(id)! < APP_DIALOG_Z,
      `${id} at ${overlayZ(id)} is not below the dialog layer at ${APP_DIALOG_Z}`
    );
  }
  reset(...ids);
});

test("a closed overlay has no z-index and no claim", () => {
  claimFront("monitor");
  assert.equal(typeof overlayZ("monitor"), "number");
  releaseFront("monitor");
  assert.equal(overlayZ("monitor"), null);
});

test("releasing the front one puts the next back on top", () => {
  claimFront("editor");
  claimFront("browser");
  releaseFront("browser");
  assert.equal(overlayZ("browser"), null);
  assert.equal(typeof overlayZ("editor"), "number");
  reset("editor");
});

/* ─── covering, which is the other half of the stack ───────────────────── */

const RECT = { left: 0, top: 0, width: 100, height: 100 };

test("a window beside another is not covered by it", () => {
  claimFront("browser");
  setOverlayRect("browser", RECT);
  claimFront("editor");
  setOverlayRect("editor", { left: 400, top: 0, width: 100, height: 100 });

  assert.equal(isCovered("browser", RECT), false);
  reset("browser", "editor");
});

test("a window overlapping a higher one is covered", () => {
  claimFront("browser");
  setOverlayRect("browser", RECT);
  claimFront("editor");
  setOverlayRect("editor", { left: 50, top: 50, width: 100, height: 100 });

  assert.equal(isCovered("browser", RECT), true);
  reset("browser", "editor");
});

test("an overlay with no rectangle covers everything", () => {
  // A modal with a full-screen backdrop registers no rectangle, and that is
  // the honest answer: it really is over the whole window.
  claimFront("browser");
  setOverlayRect("browser", RECT);
  claimFront("claude");

  assert.equal(isCovered("browser", RECT), true);
  reset("browser", "claude");
});

/* ─── Which one a key belongs to ───────────────────────────────────────────── */

test("the front overlay is the one that owns a key pressed outside them all", () => {
  // Not the same question as the z-index. Every open overlay has a
  // rank, so "do I have one" answers yes for all of them — and an
  // Escape handled by three windows at once closes three windows.
  assert.equal(isFront("figy-code"), false, "nothing is open");

  claimFront("figy-code");
  assert.equal(isFront("figy-code"), true);

  claimFront("claude");
  assert.equal(isFront("figy-code"), false, "something else is on top");
  assert.equal(isFront("claude"), true);

  claimFront("figy-code");
  assert.equal(isFront("figy-code"), true, "clicking it brings it back");

  reset("figy-code", "claude");
  assert.equal(isFront("figy-code"), false, "closed is not in front");
});

process.exit(failures === 0 ? 0 : 1);

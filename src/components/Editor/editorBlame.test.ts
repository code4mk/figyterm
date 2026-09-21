/**
 * What the blame annotation reads.
 *
 * The decoration machinery needs a document and a view, so it is not what this
 * file tests. The label is: it is a pure function of a commit and a clock, it
 * is the only part anybody actually reads, and the two mistakes available in it
 * are both silent — an age off by a unit, and git's placeholder author printed
 * as though it were a person.
 */

import assert from "node:assert/strict";
import { authorHue, authorInitials, blameAge, blameLabel } from "./editorBlame";
import { GitBlameCommit } from "../../services/git";

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

/** Epoch **seconds**, which is what git reports and what the type says. */
const NOW_SECONDS = 1_800_000_000;
const NOW = NOW_SECONDS * 1000;

function commit(partial: Partial<GitBlameCommit> = {}): GitBlameCommit {
  return {
    sha: "1111111111111111111111111111111111111111",
    short: "11111111",
    author: "Ada Lovelace",
    time: NOW_SECONDS,
    summary: "Made the thing work",
    uncommitted: false,
    ...partial,
  };
}

console.log("editor/blame");

test("the age reads in the largest unit that fits", () => {
  assert.equal(blameAge(NOW_SECONDS, NOW), "just now");
  assert.equal(blameAge(NOW_SECONDS - 30, NOW), "just now");
  assert.equal(blameAge(NOW_SECONDS - 60, NOW), "1 minute ago");
  assert.equal(blameAge(NOW_SECONDS - 120, NOW), "2 minutes ago");
  assert.equal(blameAge(NOW_SECONDS - 3600, NOW), "1 hour ago");
  assert.equal(blameAge(NOW_SECONDS - 7200, NOW), "2 hours ago");
  assert.equal(blameAge(NOW_SECONDS - 86_400, NOW), "1 day ago");
  assert.equal(blameAge(NOW_SECONDS - 3 * 86_400, NOW), "3 days ago");
});

test("the units hand over at their boundaries rather than overlapping", () => {
  // 59 minutes is still minutes; 60 is an hour. The off-by-one here reads as
  // "60 minutes ago", which is the kind of thing nobody reports and everybody
  // notices.
  assert.equal(blameAge(NOW_SECONDS - 59 * 60, NOW), "59 minutes ago");
  assert.equal(blameAge(NOW_SECONDS - 60 * 60, NOW), "1 hour ago");
  assert.equal(blameAge(NOW_SECONDS - 23 * 3600, NOW), "23 hours ago");
  assert.equal(blameAge(NOW_SECONDS - 24 * 3600, NOW), "1 day ago");
  assert.equal(blameAge(NOW_SECONDS - 30 * 86_400, NOW), "30 days ago");
  assert.equal(blameAge(NOW_SECONDS - 31 * 86_400, NOW), "1 month ago");
  assert.equal(blameAge(NOW_SECONDS - 90 * 86_400, NOW), "2 months ago");

  /*
    The anniversary. Twelve average months is 365.3 days, so asking "is it
    twelve months yet" answers no on the day itself — and the reading was
    "11 months ago" on a commit exactly a year old.
  */
  assert.equal(blameAge(NOW_SECONDS - 364 * 86_400, NOW), "11 months ago");
  assert.equal(blameAge(NOW_SECONDS - 365 * 86_400, NOW), "1 year ago");
  assert.equal(blameAge(NOW_SECONDS - 800 * 86_400, NOW), "2 years ago");
});

/*
  A commit stamped in the future.

  It happens — a machine with a wrong clock, a rebase that kept an author date
  — and the arithmetic would otherwise produce a negative age and read
  "-3 minutes ago".
*/
test("a commit from the future is not negative", () => {
  assert.equal(blameAge(NOW_SECONDS + 5000, NOW), "just now");
});

test("the label names the author, the age and the subject", () => {
  assert.equal(
    blameLabel(commit({ time: NOW_SECONDS - 7200 }), NOW),
    "Ada Lovelace, 2 hours ago • Made the thing work"
  );
});

/*
  Git calls the author of an uncommitted line "Not Committed Yet" and gives it
  an all-zero sha. Printing that as a name would be a person who does not
  exist, with a date that means nothing, beside a summary that is git's own
  description of the file rather than anybody's commit message.
*/
test("an uncommitted line says so instead of naming git's placeholder", () => {
  const label = blameLabel(
    commit({
      uncommitted: true,
      author: "Not Committed Yet",
      summary: "Version of a.txt from a.txt",
      sha: "0000000000000000000000000000000000000000",
    }),
    NOW
  );

  assert.equal(label, "Uncommitted changes");
  assert.ok(!label.includes("Not Committed Yet"));
  assert.ok(!label.includes("a.txt"));
});

test("a commit with no subject drops the bullet rather than dangling one", () => {
  assert.equal(
    blameLabel(commit({ summary: "", time: NOW_SECONDS - 86_400 }), NOW),
    "Ada Lovelace, 1 day ago"
  );
});

/*
  A commit message written to fill a terminal, on a line of code.

  Untruncated it pushes the annotation off the right of the editor, and since
  the annotation is the last thing on the line there is nothing to tell you it
  went. The whole subject is in the tooltip.
*/
test("a long subject is cut, and says that it was", () => {
  const label = blameLabel(
    commit({
      time: NOW_SECONDS - 3600,
      summary:
        "Let a script read the environment it is running in, and what it wrote",
    }),
    NOW
  );

  assert.ok(label.endsWith("…"), label);
  assert.ok(label.startsWith("Ada Lovelace, 1 hour ago • "), label);
  // The author and the age are never what gets cut: they are the two things
  // somebody is reading the annotation *for*.
  assert.ok(label.length < 100, `${label.length} characters`);
});

test("a subject that fits is left alone", () => {
  const label = blameLabel(commit({ summary: "Fix the parser", time: NOW_SECONDS }), NOW);
  assert.equal(label, "Ada Lovelace, just now • Fix the parser");
  assert.ok(!label.includes("…"));
});

/*
  The avatar. Initials rather than a fetched picture, so this has to work for
  every shape of name git reports — and git reports whatever was in
  `user.name`, which is not always two words and not always Latin.
*/
test("initials come from the first and last word of a name", () => {
  assert.equal(authorInitials("Mostafa Kamal"), "MK");
  assert.equal(authorInitials("Ada"), "A");
  assert.equal(authorInitials("ada lovelace"), "AL");
  assert.equal(authorInitials("Ada Byron King Lovelace"), "AL", "first and last, not all four");
});

test("a name with nothing alphabetic in it still gets a mark", () => {
  assert.equal(authorInitials(""), "·");
  assert.equal(authorInitials("   "), "·");
  assert.equal(authorInitials("!!!"), "·");
});

test("punctuation and non-Latin names are read, not skipped", () => {
  // One whitespace-separated token, so one initial — and the first *letter*
  // in it, not the angle bracket it starts with.
  assert.equal(authorInitials("<ada@example.com>"), "A");
  assert.equal(authorInitials("মোস্তাফা কামাল"), "মক");
  assert.equal(authorInitials("Zoë Çelik"), "ZÇ");
});

/*
  The colour is a function of the name, so the same person is the same colour
  in every file and across restarts. A hue that moved between sessions would
  make the avatar decoration rather than identification.
*/
test("an author's hue is stable and in range", () => {
  assert.equal(authorHue("Mostafa Kamal"), authorHue("Mostafa Kamal"));
  assert.notEqual(authorHue("Ada Lovelace"), authorHue("Grace Hopper"));

  for (const name of ["", "A", "Ada Lovelace", "মোস্তাফা কামাল", "x".repeat(200)]) {
    const hue = authorHue(name);
    assert.ok(Number.isInteger(hue), `${name}: ${hue}`);
    assert.ok(hue >= 0 && hue < 360, `${name}: ${hue}`);
  }
});

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}

/**
 * Who last changed the line the cursor is on, at the end of that line.
 *
 * The annotation everybody knows from GitLens, and the reason it is worth
 * having is the question it answers without being asked: you are reading a line
 * you do not understand, and the person who wrote it and the commit that
 * explains why are one glance away rather than a `git blame` in another window.
 *
 * **One line at a time, the cursor's.** Blaming every visible line is the other
 * way to do this and it turns the right-hand half of the editor into a second
 * document — one you are not reading, in a colour you cannot ignore. The cursor
 * is already where the attention is.
 *
 * Hovering it opens the commit in full.
 *
 * **Not through `hoverTooltip`, and that took two goes to get right.** The
 * first version floated a box of its own and put `pointer-events: none` on the
 * annotation — which is what made the hover look broken, because an element
 * that receives no pointer events is never hovered. The obvious fix was
 * CodeMirror's own `hoverTooltip`, which is what the language server uses and
 * would have brought its look and its positioning for free; but it will not
 * fire here. It guards on the pointer being within one character width of a
 * document position (`tooltip.ts`, `checkHover`), and the annotation sits
 * several characters past the end of the line.
 *
 * So the hover is the element's own, and the look is borrowed instead of the
 * mechanism: the tooltip wears the same box as the editor's other popups and is
 * placed by `@floating-ui/dom`, which is what positions the completion list and
 * the rename box already.
 *
 * ## What happens when you type
 *
 * Blame is answered per line *number*, and line numbers move the moment
 * anything above them is edited. Rather than try to follow them, the field
 * remembers **how far down the file the answer is still true**: an edit on line
 * 40 leaves 1–39 correct and makes everything from 40 unknown, so the
 * annotation stops appearing there until the next `git blame` — which happens
 * on save, when it would have changed anyway.
 *
 * One integer, no mapping, and never a wrong name against a line. That last
 * part is the whole point: a missing annotation costs a glance, and a wrong one
 * gets believed.
 */

import { EditorState, Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { GitBlame, GitBlameCommit, gitCommitDetail } from "../../services/git";
import { commitUrl, Remote } from "../../services/git-forge";

/** How long the pointer rests before the commit opens. */
const HOVER_DELAY_MS = 220;

/** Past this the inline subject is cut — it is sharing a line with code. */
const MAX_SUBJECT = 60;

/** The blame for a file, and the repository it was asked of. */
export interface BlameSource {
  /** The workspace directory, for fetching a commit's body on hover. */
  dir: string;
  blame: GitBlame;
  /**
   * The forge this repository is pushed to, where there is one.
   *
   * Carried so the sha in the tooltip can open the commit. Null on a
   * repository with no remote, or one on a host `git-forge.ts` does not know
   * how to build a URL for — and then the sha is plain text rather than a link
   * that goes nowhere.
   */
  remote: Remote | null;
}

/** Hands a file's blame to the editor, or clears it with `null`. */
export const setBlame = StateEffect.define<BlameSource | null>();

interface BlameState {
  source: BlameSource | null;
  /**
   * The last line whose answer is still true, 1-based. Zero means none are.
   *
   * See the note at the top: this is what replaces following line numbers
   * through edits.
   */
  safeUntil: number;
}

const blameField = StateField.define<BlameState>({
  create: () => ({ source: null, safeUntil: 0 }),

  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setBlame)) continue;
      return {
        source: effect.value,
        safeUntil: effect.value ? effect.value.blame.lines.length : 0,
      };
    }

    if (!transaction.docChanged || !value.source) return value;

    // The topmost line any change touched, in the document as it was *before*
    // them — which is the document the blame describes.
    let first = Number.MAX_SAFE_INTEGER;
    transaction.changes.iterChangedRanges((fromA) => {
      first = Math.min(first, transaction.startState.doc.lineAt(fromA).number);
    });

    return { ...value, safeUntil: Math.min(value.safeUntil, first - 1) };
  },
});

/** The commit for a line, or null where there is no answer worth trusting. */
function commitAt(state: EditorState, line: number): GitBlameCommit | null {
  const held = state.field(blameField, false);
  if (!held?.source || line > held.safeUntil) return null;
  const at = held.source.blame.lines[line - 1];
  if (at === undefined) return null;
  return held.source.blame.commits[at] ?? null;
}

/**
 * "3 days ago", in the largest unit that fits.
 *
 * One unit, never two: "3 days, 4 hours ago" is a precision nobody wants from
 * an annotation sitting at the end of a line of code, where every character is
 * competing with the code for the same glance.
 */
export function blameAge(seconds: number, now: number): string {
  const elapsed = Math.max(0, Math.floor(now / 1000) - seconds);
  if (elapsed < 60) return "just now";

  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;

  /*
    The handover to years is on **days**, not on twelve months.

    A month here is the average 30.44 days, so twelve of them is 365.3 — and a
    commit exactly a year old divides to 11.99, floors to 11, and reads
    "11 months ago" for the day or two either side of its anniversary. Asking
    the question in days puts the boundary where a reader expects it.
  */
  if (days < 365) {
    const months = Math.floor(days / 30.44);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }

  // Clamped: 365 days over 365.25 floors to zero, and "0 years ago" is not a
  // thing anybody has ever wanted to read.
  const years = Math.max(1, Math.floor(days / 365.25));
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** The commit date in full, for the tooltip. */
export function blameDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What the inline annotation reads.
 *
 * The subject is cut, because it is sharing the line with code and a commit
 * message written to fill a terminal would otherwise push the annotation off
 * the right of the editor. The whole of it is in the tooltip, which has room.
 */
export function blameLabel(commit: GitBlameCommit, now: number): string {
  // An uncommitted line is not an unknown one, and naming git's placeholder
  // author ("Not Committed Yet") as though it were a person would be worse
  // than saying nothing.
  if (commit.uncommitted) return "Uncommitted changes";

  const subject =
    commit.summary.length > MAX_SUBJECT
      ? `${commit.summary.slice(0, MAX_SUBJECT - 1).trimEnd()}…`
      : commit.summary;

  const age = blameAge(commit.time, now);
  return subject ? `${commit.author}, ${age} • ${subject}` : `${commit.author}, ${age}`;
}

// ─── The inline annotation ──────────────────────────────────────────────────

class BlameWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly commit: GitBlameCommit,
    readonly source: { dir: string; remote: Remote | null } | null
  ) {
    super();
  }

  eq(other: BlameWidget): boolean {
    return other.label === this.label && other.commit.sha === this.commit.sha;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-blame";
    span.textContent = this.label;
    // A note about the line rather than part of it, so a screen reader
    // following the code does not read a commit message mid-statement.
    span.setAttribute("aria-hidden", "true");

    /*
      Opened by **movement over the text**, not by the element appearing under
      the pointer.

      The distinction matters because of where this lives. Clicking a line puts
      the caret there, which puts a new annotation at the end of it — often
      directly under the pointer that just clicked. `mouseenter` is generous
      about that, so a click read as a hover and the commit opened on its own;
      `mousemove` cannot, because it needs the pointer to actually travel across
      the label. Together with the margin that holds the gap (see `.cm-blame` in
      the stylesheet) the trigger is exactly the words of the note and nothing
      around them.

      A delay as well, like every other hover here: the annotation sits at the
      end of the line the caret is on, so the pointer crosses it on the way
      somewhere else far more often than it stops there.
    */
    span.addEventListener("mousemove", () => {
      // Coming back to the annotation from the tooltip: keep what is up, and
      // do not queue a second one.
      cancelClose();
      if (showing || pending) return;
      pending = setTimeout(() => {
        pending = null;
        openTooltip(span, this.commit, this.source);
      }, HOVER_DELAY_MS);
    });

    span.addEventListener("mouseleave", () => {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      closeSoon();
    });

    /*
      A press is not a hover.

      Clicking on or near the note is how somebody puts the caret at the end of
      the line; it is not a request to read the commit. So a press takes down
      whatever is up and cancels whatever was queued, and the pointer has to
      move again to ask.
    */
    span.addEventListener("mousedown", closeTooltip);

    return span;
  }

  /** Taken down with the annotation, so a scroll cannot leave one behind. */
  destroy(): void {
    closeTooltip();
  }

  /**
   * Events here are not the document's: a click on the note must not move the
   * caret to the end of the line.
   *
   * This is what keeps the caret off it — *not* a `pointer-events: none` in the
   * stylesheet, which is where the first version put it and is what stopped the
   * hover above from ever firing. The listeners are the element's own and are
   * unaffected by this: `ignoreEvent` only tells CodeMirror not to read a press
   * here as a position in the document.
   */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The widget, at the end of the line the cursor is on.
 *
 * Nothing at all while there is a selection: the annotation sits where the
 * selected text ends, and a note appearing inside a range somebody is about to
 * copy is a note in the way.
 */
function annotation(view: EditorView, now: number): DecorationSet {
  const selection = view.state.selection.main;
  if (!selection.empty) return Decoration.none;

  const line = view.state.doc.lineAt(selection.head);
  const commit = commitAt(view.state, line.number);
  if (!commit) return Decoration.none;

  const held = view.state.field(blameField, false)?.source ?? null;
  const source = held ? { dir: held.dir, remote: held.remote } : null;

  return Decoration.set([
    Decoration.widget({
      widget: new BlameWidget(blameLabel(commit, now), commit, source),
      side: 1,
    }).range(line.to),
  ]);
}

const blameView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = annotation(view, Date.now());
    }

    update(update: ViewUpdate) {
      const arrived = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setBlame))
      );
      if (update.docChanged || update.selectionSet || arrived) {
        this.decorations = annotation(update.view, Date.now());
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

// ─── The commit, on hover ───────────────────────────────────────────────────

/**
 * Message bodies already fetched, by repository and sha.
 *
 * Blame gives the subject and nothing else, so the body — the paragraphs that
 * say *why*, which is most of the reason to look a commit up at all — costs one
 * `git show`. Cached, because hovering the same line twice is the commonest
 * thing anybody does with this; bounded, because a long session in a busy file
 * would otherwise hold every commit message in it.
 */
const bodies = new Map<string, string>();
const MAX_BODIES = 200;

async function commitBody(dir: string, sha: string): Promise<string> {
  const key = `${dir}\n${sha}`;
  const held = bodies.get(key);
  if (held !== undefined) return held;

  let body = "";
  try {
    body = (await gitCommitDetail(dir, sha)).body.trim();
  } catch {
    // A commit git will not describe — a shallow clone that does not have it,
    // a grafted history — still has everything blame already said. The tooltip
    // is shorter, and says nothing false.
    body = "";
  }

  if (bodies.size >= MAX_BODIES) bodies.clear();
  bodies.set(key, body);
  return body;
}

/**
 * The first letter of a name, for the avatar.
 *
 * The same rule the workspace picker uses, and the same idea: initials in a
 * tinted square rather than a fetched picture. This app does not talk to the
 * network for anything, and an avatar is not the thing to start with — a
 * Gravatar means hashing somebody's email and asking a third party who they
 * are every time a file is opened.
 */
export function authorInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => Array.from(word).find((character) => /\p{L}|\p{N}/u.test(character)))
    .filter((letter): letter is string => letter !== undefined);

  // Two for a name with two words, one for anything else — "MK" for Mostafa
  // Kamal, "A" for ada, "·" for a name with no letters in it at all.
  if (letters.length === 0) return "·";
  const initials = letters.length >= 2 ? `${letters[0]}${letters[letters.length - 1]}` : letters[0]!;
  return initials!.toUpperCase();
}

/**
 * A hue for an author, stable across sessions.
 *
 * Derived from the name so the same person is the same colour every time, and
 * two people in one file are rarely the same one. A hash rather than a palette
 * index because there is no list of authors to index into — a repository has as
 * many as it has.
 */
export function authorHue(name: string): number {
  let hash = 0;
  for (let at = 0; at < name.length; at++) {
    hash = (hash * 31 + name.charCodeAt(at)) % 360;
  }
  return hash;
}

/**
 * The tooltip, without its body.
 *
 * Built from what blame already knows so it can be on screen the moment the
 * pointer settles; `openTooltip` appends the message body when git answers.
 */
function tooltipDom(
  commit: GitBlameCommit,
  remote: Remote | null,
  now: number
): HTMLElement {
  /*
    Styled in `styles.css` rather than by the editor's theme, and not for want
    of trying: `.cm-tooltip` is defined through `EditorView.theme`, which scopes
    its rules under a class on the editor root, and this is appended to the body
    so that the scroller cannot clip it. The stylesheet reproduces that box
    against the same `--ft-*` tokens, which is what keeps the two looking alike.
  */
  const dom = document.createElement("div");
  dom.className = "cm-blame-tooltip";

  if (commit.uncommitted) {
    const subject = document.createElement("div");
    subject.className = "cm-blame-subject";
    subject.textContent = "Uncommitted changes";

    const note = document.createElement("div");
    note.className = "cm-blame-meta";
    note.textContent = "This line is in the working file and nowhere else yet.";

    dom.append(subject, note);
    return dom;
  }

  // ── Who, and when ───────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "cm-blame-head";

  const avatar = document.createElement("span");
  avatar.className = "cm-blame-avatar";
  avatar.textContent = authorInitials(commit.author);
  // Set here rather than in the stylesheet because the hue is the author's:
  // CSS cannot derive a colour from a name, and a class per author is not a
  // thing a stylesheet can have.
  avatar.style.setProperty("--blame-hue", String(authorHue(commit.author)));

  const who = document.createElement("div");
  who.className = "cm-blame-who";

  const author = document.createElement("span");
  author.className = "cm-blame-author";
  author.textContent = commit.author;

  const when = document.createElement("span");
  when.className = "cm-blame-when";
  when.textContent = `${blameAge(commit.time, now)} · ${blameDate(commit.time)}`;

  who.append(author, when);
  head.append(avatar, who);

  // ── What it said ────────────────────────────────────────────────────────
  const subject = document.createElement("div");
  subject.className = "cm-blame-subject";
  // In full and wrapped, unlike the inline label.
  subject.textContent = commit.summary || "(no subject)";

  dom.append(head, subject);

  // ── The sha, and the two things anybody does with one ───────────────────
  const foot = document.createElement("div");
  foot.className = "cm-blame-foot";

  /*
    A link when the repository has a remote this build can build a URL for,
    plain text when it does not — rather than a link that opens nothing, which
    is the worse of the two answers. `git-forge.ts` is the same module the
    commit rows in source control use, so a sha opens the same page from both.
  */
  const href = remote ? commitUrl(remote, commit.sha) : "";
  const sha = document.createElement(href ? "a" : "code");
  sha.className = href ? "cm-blame-sha is-link" : "cm-blame-sha";
  sha.textContent = commit.short;

  if (href && sha instanceof HTMLAnchorElement) {
    sha.href = href;
    sha.title = `Open ${commit.short} on ${remote!.host}`;
    sha.addEventListener("click", (event) => {
      // The webview must not navigate: this window is the app. The forge
      // belongs in the browser the person already has their session in.
      event.preventDefault();
      event.stopPropagation();
      void openExternal(href).catch(() => {});
      closeTooltip();
    });
  }

  /*
    Copy, beside it.

    The **full** sha, not the abbreviation on the chip: what anybody pastes a
    sha into is a git command or a review, and forty characters is the form
    that is never ambiguous. The button says what it copied afterwards, because
    a copy that gives no sign of having happened gets pressed twice.
  */
  const copy = document.createElement("button");
  copy.className = "cm-blame-copy";
  copy.type = "button";
  copy.title = "Copy the full commit hash";
  copy.setAttribute("aria-label", "Copy the full commit hash");
  copy.textContent = "Copy";
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard
      ?.writeText(commit.sha)
      .then(() => {
        copy.textContent = "Copied";
        copy.classList.add("done");
      })
      .catch(() => {
        copy.textContent = "Press ⌘C";
      });
  });

  foot.append(sha, copy);
  dom.append(foot);

  return dom;
}

/**
 * The one tooltip on screen, and what takes it down.
 *
 * Module-level because there is at most one annotation — the cursor's line —
 * so there is at most one of these, and because a widget replaced while its
 * tooltip is up must not leave the old one floating.
 */
let showing: { element: HTMLElement; token: number } | null = null;
let nextToken = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let closing: ReturnType<typeof setTimeout> | null = null;

/**
 * How long the tooltip survives the pointer leaving.
 *
 * Long enough to cross the gap. The tooltip is offset six pixels from the
 * annotation, so reaching it means leaving the annotation first — and closing
 * on that `mouseleave` made the tooltip impossible to reach at all, which is
 * what it did. Either element entering cancels this, so the pointer can move
 * between them freely and only leaving both closes it.
 */
const CLOSE_GRACE_MS = 220;

function cancelClose(): void {
  if (!closing) return;
  clearTimeout(closing);
  closing = null;
}

function closeTooltip(): void {
  cancelClose();
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  showing?.element.remove();
  showing = null;
}

/** Closes after the grace period, unless something cancels it first. */
function closeSoon(): void {
  cancelClose();
  closing = setTimeout(() => {
    closing = null;
    closeTooltip();
  }, CLOSE_GRACE_MS);
}

/**
 * Puts the tooltip beside the annotation and keeps it on screen.
 *
 * `@floating-ui/dom`, the same library that places the completion list and the
 * rename box: `flip` moves it below when there is no room above, and `shift`
 * pulls it back in when the annotation is near an edge — which it often is,
 * being the last thing on a line.
 */
async function place(anchor: HTMLElement, element: HTMLElement): Promise<void> {
  const { x, y } = await computePosition(anchor, element, {
    placement: "top-start",
    strategy: "fixed",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
}

/**
 * Opens the commit behind one annotation.
 *
 * The body is fetched while the tooltip is already up rather than before it:
 * everything blame knows is on screen immediately, and the paragraphs arrive
 * when git answers. `token` is what stops a slow answer from filling in a
 * tooltip the pointer has already left.
 */
function openTooltip(
  anchor: HTMLElement,
  commit: GitBlameCommit,
  source: { dir: string; remote: Remote | null } | null
): void {
  closeTooltip();

  const token = ++nextToken;
  const element = tooltipDom(commit, source?.remote ?? null, Date.now());

  /*
    The tooltip keeps itself open.

    Entering it cancels the close the annotation's `mouseleave` started, which
    is what makes the sha reachable — without this the pointer could never get
    there, because leaving the annotation is how you travel towards it.
  */
  element.addEventListener("mouseenter", cancelClose);
  element.addEventListener("mouseleave", closeSoon);

  document.body.append(element);
  showing = { element, token };
  void place(anchor, element);

  if (commit.uncommitted || !source) return;

  void commitBody(source.dir, commit.sha).then((body) => {
    if (!body || showing?.token !== token) return;
    const paragraphs = document.createElement("div");
    paragraphs.className = "cm-blame-body";
    // Verbatim, wrapped by CSS. A commit message's own line breaks are part of
    // how it was written, and reflowing it runs its paragraphs together.
    paragraphs.textContent = body;
    // Above the footer, not appended: the sha and its Copy button are already
    // there, and the message belongs between the subject and them rather than
    // under the controls.
    element.insertBefore(paragraphs, element.querySelector(".cm-blame-foot"));
    // Re-placed: it just got taller, and a tooltip above the line grows
    // upwards into whatever is there.
    void place(anchor, element);
  });
}

/**
 * The whole feature, for a compartment.
 *
 * Turning it off in settings reconfigures the compartment to nothing, which
 * drops the field, the annotation and the hover together.
 */
export function gitBlameAnnotation(): Extension {
  return [blameField, blameView];
}

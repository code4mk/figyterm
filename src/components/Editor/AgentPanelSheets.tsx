/**
 * The agent panel's screens — what the window shows in dialogs.
 *
 * ## One sheet, five views
 *
 * These began as five separate screens, each reached by typing its own
 * command and left by pressing Escape. That is how the *window* works
 * and it is right there: a dialog opens over a transcript you can
 * still see, and its five have nothing to do with each other.
 *
 * Here they do. At 320px a sheet is not *over* the column, it **is**
 * the column — so five of them are five places to be with no way
 * between them except out and back in through a command. And they are
 * all answers to one question: *what is this conversation doing, and
 * what is it costing.* So they are one sheet with a switcher, which
 * also makes four of them discoverable to somebody who only ever typed
 * `/context`.
 *
 * The switcher is `SegmentedTabs` — the same control the editor's own
 * side column uses for Files · Search · Source Control, so the two
 * look like the same kind of choice, which they are. Icons without
 * labels: five words do not fit in 300px and half a word is worse than
 * the icon alone.
 *
 * ## Why these are not the window's components
 *
 * Reusing `ContextDialog` and `UsageDialog` was the first attempt.
 * They are built around a dialog frame — a fixed overlay, a backdrop,
 * a 560px minimum, three figures abreast — and the parts that would
 * have to be stripped to fit are most of what they are. What is
 * actually shared is the data and the arithmetic, both of which come
 * through props.
 *
 * ## The one idea that makes a narrow column readable
 *
 * A percentage column does not work at this width. Label, number and
 * share are three columns in 300px, and the labels — "Tool results",
 * "Tool definitions" — truncate to nothing long before the numbers do.
 * So every proportion is drawn as a **bar under its own row**: it
 * reads at a glance, it costs no horizontal space, and the number
 * stays exact beside the label.
 */

import {
  Boxes,
  ChevronLeft,
  Clock,
  Cpu,
  FolderOpen,
  Layers,
  Trash2,
  Wallet,
  X,
} from "lucide-react";

import { SegmentedTabs } from "../Shared/SegmentedTabs";
import {
  settingsFrom,
  type AgentSettings,
  type AgentStatus,
  type ContextBreakdown,
  type Conversation,
  type ProjectRules,
  type RouterCheck,
  type ToolInfo,
  type Totals,
} from "../../services/figycode-agent";
import type { ProjectInfo } from "../../services/figycode-files";
import { collapseHome } from "../../services/recent-dirs";
import { formatCost, formatTokens, type Notice } from "../../services/figycode-blocks";
import {
  CONTEXT_EMPTY,
  RESUME_EMPTY,
  RESUME_NOTE,
  TOOLS_EMPTY,
  USAGE_EMPTY,
  cacheWord,
  contextView,
  type Screen,
  conversationRow,
  toolsView,
  usageView,
} from "../../services/figycode-views";

/**
 * Which screen the sheet is on, or none.
 *
 * `Screen` is the shared name — the same one the window's dialogs use,
 * so a command cannot open a screen on one surface and nothing on the
 * other. This file had its own list once, and the entry it was missing
 * was `project`.
 */
export type Sheet = Screen | null;

const TITLE: Record<Screen, string> = {
  context: "Context",
  usage: "Tokens and spend",
  tools: "Tools",
  resume: "Earlier here",
  settings: "Model",
  project: "Project",
};

/**
 * The switcher.
 *
 * Ordered by how often it is wanted rather than alphabetically: what
 * is filling the window and what it has cost are the two somebody
 * opens this for, and the model is the one they came to change.
 */
const SEGMENTS = [
  { value: "project" as const, icon: <FolderOpen size={12} />, label: "Project", aria: "Project" },
  { value: "context" as const, icon: <Layers size={12} />, label: "Context", aria: "Context" },
  { value: "usage" as const, icon: <Wallet size={12} />, label: "Spend", aria: "Tokens and spend" },
  { value: "tools" as const, icon: <Boxes size={12} />, label: "Tools", aria: "Tools" },
  { value: "resume" as const, icon: <Clock size={12} />, label: "Earlier", aria: "Earlier here" },
  { value: "settings" as const, icon: <Cpu size={12} />, label: "Model", aria: "Model" },
];

export function PanelSheet({
  sheet,
  onView,
  context,
  totals,
  past,
  status,
  tools,
  root,
  index,
  rules,
  onResume,
  onForget,
  onPick,
  onTest,
  onNotice,
  onClose,
}: {
  sheet: Screen;
  /** Switching view, which also loads whatever that view needs. */
  onView: (screen: Screen) => void;
  context: ContextBreakdown | null;
  totals: Totals | null;
  past: Conversation[];
  status: AgentStatus;
  tools: ToolInfo[];
  /** The folder, and what the `@` index found in it. */
  root: string | null;
  index: ProjectInfo | null;
  rules: ProjectRules | null;
  onResume: (sessionId: string) => void;
  onForget: (sessionId: string) => void;
  onPick: (next: AgentSettings) => void;
  onTest: () => Promise<RouterCheck>;
  onNotice: (notice: Notice) => void;
  onClose: () => void;
}) {
  const model = status.models.find((m) => m.id === status.active);

  return (
    <div className="figy-sheet" role="dialog" aria-label={TITLE[sheet]}>
      <header className="figy-sheet-head">
        <button
          type="button"
          className="figy-sheet-icon"
          onClick={onClose}
          title="Back to the conversation"
          aria-label="Back to the conversation"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="figy-sheet-heading">
          <span className="figy-sheet-title">{TITLE[sheet]}</span>
          {/*
            The model, under the title.

            Every one of these views is about one model's conversation,
            and the figures mean different things under a different
            one. Saying it once here is cheaper than a row on each.
          */}
          <span className="figy-sheet-sub">{model?.label ?? "No model"}</span>
        </div>
        <button
          type="button"
          className="figy-sheet-icon"
          onClick={onClose}
          title="Close"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </header>

      <div className="figy-sheet-tabs">
        <SegmentedTabs
          segments={SEGMENTS}
          value={sheet}
          onChange={onView}
          ariaLabel="What to look at"
          showLabels={false}
        />
      </div>

      <div className="figy-sheet-body">
        {sheet === "project" && (
          <ProjectView
            root={root}
            index={index}
            rules={rules}
            status={status}
            earlier={past.length}
          />
        )}
        {sheet === "context" && <ContextView context={context} />}
        {sheet === "usage" && <UsageView totals={totals} />}
        {sheet === "tools" && <ToolsView tools={tools} context={context} />}
        {sheet === "resume" && <ResumeView past={past} onResume={onResume} onForget={onForget} />}
        {sheet === "settings" && (
          <ModelView status={status} onPick={onPick} onTest={onTest} onNotice={onNotice} />
        )}
      </div>
    </div>
  );
}

/* ─── The pieces every view is built from ─────────────────────────────────── */

/** The one number a view is about, before anything that explains it. */
function Figure({
  value,
  unit,
  note,
  tone,
}: {
  value: string;
  unit?: string;
  note?: string;
  tone?: "warn";
}) {
  return (
    <div className={`figy-sheet-figure ${tone ?? ""}`}>
      <div className="figy-sheet-figure-line">
        <span className="figy-sheet-figure-value">{value}</span>
        {unit && <span className="figy-sheet-figure-unit">{unit}</span>}
      </div>
      {note && <span className="figy-sheet-figure-note">{note}</span>}
    </div>
  );
}

/**
 * A row, with its share drawn under it.
 *
 * `share` is a fraction of whatever the view is measuring against —
 * the sum of the parts, or the largest row. Left off when the number
 * is money, where a bar would imply a proportion of a budget nobody
 * set.
 */
function Row({
  label,
  note,
  value,
  share,
  tint,
  /** The one row in a group that is the sum of the others. */
  emphasis,
}: {
  label: string;
  note?: string;
  value: string;
  share?: number;
  tint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`figy-sheet-row ${emphasis ? "total" : ""}`}>
      <div className="figy-sheet-row-line">
        <span className="figy-sheet-row-label">{label}</span>
        <span className="figy-sheet-row-value">{value}</span>
      </div>
      {note && <span className="figy-sheet-row-note">{note}</span>}
      {share !== undefined && (
        <span className="figy-sheet-row-track" aria-hidden>
          <span
            className={`figy-sheet-row-fill ${tint ?? ""}`}
            style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
          />
        </span>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="figy-sheet-empty">{children}</p>;
}

/* ─── Project ─────────────────────────────────────────────────────────────── */

/**
 * The folder, the index, the rules and the model.
 *
 * The window's `/project` is also where a folder is *chosen* and where
 * folders are granted and revoked. None of that belongs here: the
 * editor owns which folder is open, and a panel that could move the
 * project out from under the buffer beside it would be answering a
 * question nobody asked.
 *
 * So this is the reading half — the same facts the window's first
 * screen states, which stop being visible the moment a conversation
 * starts and do not stop being the things worth checking.
 */
function ProjectView({
  root,
  index,
  rules,
  status,
  earlier,
}: {
  root: string | null;
  index: ProjectInfo | null;
  rules: ProjectRules | null;
  status: AgentStatus;
  earlier: number;
}) {
  if (!root) {
    return <Empty>No folder is open. Open one in the editor and the agent follows it.</Empty>;
  }

  const model = status.models.find((m) => m.id === status.active);

  return (
    <>
      <Figure
        value={index ? `${index.files}` : "…"}
        unit={index ? `file${index.files === 1 ? "" : "s"} indexed` : "indexing"}
        note={
          index
            ? `${index.folders} folder${index.folders === 1 ? "" : "s"}${
                index.truncated ? " · stopped early, the index is not everything" : ""
              }`
            : "the walk happens once, so the first @ is as quick as the twentieth"
        }
        tone={index?.truncated ? "warn" : undefined}
      />

      <div className="figy-sheet-rows">
        {/* `~` rather than the whole path: the home prefix is the same
            on every row anybody has ever read. */}
        <Row label="Folder" value={collapseHome(root)} />
        <Row
          label="Model"
          note={model ? model.model : undefined}
          value={model?.label ?? "None set up"}
        />
        <Row
          label="Rules"
          note={rules ? `${formatTokens(rules.tokens)} of the prompt` : undefined}
          value={rules?.name ?? "None"}
        />
        <Row
          label="Earlier here"
          note={earlier > 0 ? "under Earlier" : undefined}
          value={`${earlier}`}
        />
      </div>

      {rules?.truncated && (
        <p className="figy-sheet-note">
          {rules.name} is past the cap and was cut — the model is told so, rather than being
          given a file that stops mid-sentence as if it had ended.
        </p>
      )}

      <p className="figy-sheet-note">
        The editor decides which folder this is, and the agent follows it. Granting the agent
        other folders is done in the FigyCode window.
      </p>
    </>
  );
}

/* ─── Context ─────────────────────────────────────────────────────────────── */

/**
 * What is in the window, and what cannot be got back out of it.
 *
 * Every label, every order, every number and every footnote comes from
 * `contextView`, which the FigyCode window's dialog renders too. This
 * used to have five parts of its own in an order of its own and led
 * with a different number — two screens about the same conversation
 * that could not both be right.
 *
 * What is still this file's is the *shape*: the window has room for a
 * colour key, a note per row and a percentage column, and at 320px
 * those are a bar under each row instead.
 */
function ContextView({ context }: { context: ContextBreakdown | null }) {
  if (!context) return <Empty>{CONTEXT_EMPTY}</Empty>;

  const view = contextView(context);

  return (
    <>
      {/*
        The estimate, like the window — not the measured count.

        Leading with `measured` was this file's own idea and it made the
        headline disagree with every row under it: the parts are an
        estimate and `measured` is the provider's exact figure for one
        turn. The exact number is still here, in the facts below, said
        as what it is.
      */}
      <Figure
        value={formatTokens(view.estimated)}
        unit={view.window > 0 ? `of ${formatTokens(view.window)}` : "estimated"}
        note={view.percent !== null ? `${view.percent}% full` : undefined}
        tone={view.percent !== null && view.percent > 75 ? "warn" : undefined}
      />

      {/*
        One bar, in wire order. Not a pie: these are parts of a
        sequence — tools, then the prompt, then the conversation — and
        the order is the thing that decides what a cache keeps.
      */}
      <div className="figy-sheet-bar" role="img" aria-label={`${view.percent ?? 0}% of the window`}>
        {view.parts
          .filter((part) => part.tokens > 0)
          .map((part) => (
            <span
              key={part.key}
              className={`figy-sheet-bar-slice ${part.key}`}
              style={{ flexGrow: part.share }}
              title={`${part.label}: ${formatTokens(part.tokens)} tokens`}
            />
          ))}
        {view.free > 0 && (
          <span
            className="figy-sheet-bar-slice free"
            style={{ flexGrow: view.freeShare }}
          />
        )}
      </div>

      <div className="figy-sheet-rows">
        {view.parts.map((part) => (
          <Row
            key={part.key}
            label={part.label}
            note={part.note}
            value={formatTokens(part.tokens)}
            share={part.share}
            tint={part.key}
          />
        ))}
        {view.window > 0 && (
          <Row
            label="Free"
            value={formatTokens(view.free)}
            share={view.freeShare}
            tint="free"
          />
        )}
      </div>

      {/*
        The actionable half. A result that was expensive once is
        expensive on every turn after it, so the name beside the number
        is what changes what somebody does next.
      */}
      {view.heaviest.length > 0 && (
        <section className="figy-sheet-section">
          <h3 className="figy-sheet-section-head">Heaviest results</h3>
          <p className="figy-sheet-lede">{view.heaviestNote}</p>
          <div className="figy-sheet-rows">
            {view.heaviest.map((one, i) => (
              <Row
                key={`${i}-${one.name}`}
                label={one.name}
                value={formatTokens(one.tokens)}
                share={one.share}
                tint="toolResults"
              />
            ))}
          </div>
        </section>
      )}

      <div className="figy-sheet-facts">
        {view.facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
    </>
  );
}

/* ─── Spend ───────────────────────────────────────────────────────────────── */

/**
 * What the session has cost, and whether the cache is working.
 *
 * The same figures the window's dialog shows, from `usageView` — this
 * used to leave out the turn count, the input total and the spend
 * total, so the two screens added up differently.
 */
function UsageView({ totals }: { totals: Totals | null }) {
  if (!totals || totals.turns === 0) return <Empty>{USAGE_EMPTY}</Empty>;

  const view = usageView(totals);

  return (
    <>
      <Figure
        value={formatCost(view.total)}
        unit={`over ${view.turns} turn${view.turns === 1 ? "" : "s"}`}
        note={`${formatCost(view.perTurn)} a turn · ${formatTokens(totals.input)} in · cache ${
          view.hitRate
        }% ${cacheWord(totals)}`}
      />

      {/*
        Input against output, to scale. The point it makes in one
        glance is the one a sentence used to make: output is a rounding
        error, and almost all of what you pay for is the conversation
        being re-sent.
      */}
      <div className="figy-sheet-bar" role="img" aria-label="Where the tokens went">
        {view.flow
          .filter((one) => one.tokens > 0)
          .map((one) => (
            <span
              key={one.key}
              className={`figy-sheet-bar-slice ${one.key}`}
              style={{ flexGrow: one.share }}
              title={`${formatTokens(one.tokens)} ${one.label.toLowerCase()}`}
            />
          ))}
      </div>

      <div className="figy-sheet-rows">
        {view.flow.map((one) => (
          <Row
            key={one.key}
            label={one.label}
            value={formatTokens(one.tokens)}
            share={one.share}
            tint={one.key}
          />
        ))}
      </div>

      <section className="figy-sheet-section">
        <h3 className="figy-sheet-section-head">Spend</h3>
        <div className="figy-sheet-rows">
          {view.spend.map((one) => (
            <Row
              key={one.key}
              label={one.label}
              note={one.note}
              value={formatCost(one.cost)}
              emphasis={one.total}
            />
          ))}
        </div>
      </section>

      {view.largest && (
        <p className="figy-sheet-note">
          Largest single tool result: <strong>{formatTokens(view.largest.tokens)}</strong> —{" "}
          {view.largest.note}.
        </p>
      )}

      {view.verdict && (
        <div className={`figy-sheet-verdict ${view.verdict.healthy ? "good" : "warn"}`}>
          <span className="figy-sheet-verdict-value">{view.verdict.value}</span>
          <span className="figy-sheet-verdict-text">{view.verdict.text}</span>
        </div>
      )}
    </>
  );
}

/* ─── Tools ───────────────────────────────────────────────────────────────── */

/**
 * What the model is offered, and what offering it costs.
 *
 * `toolsView` again, so the count, the weights, the order and the
 * footnote are the window's. What this leaves out is the per-tool
 * description — the window puts it behind a disclosure, and a
 * paragraph of prose in a 300px column with no room for the
 * disclosure's indent is not the same control drawn smaller.
 */
function ToolsView({ tools, context }: { tools: ToolInfo[]; context: ContextBreakdown | null }) {
  if (tools.length === 0) return <Empty>{TOOLS_EMPTY}</Empty>;

  const view = toolsView(tools, context);

  return (
    <>
      <Figure
        value={formatTokens(view.total)}
        unit="of definitions"
        note={`${view.count} tools · ${formatTokens(view.average)} each · ${view.classes
          .map((one) => `${one.n} ${one.cls}`)
          .join(" · ")}`}
      />

      <div className="figy-sheet-bar" role="img" aria-label="What the definitions weigh">
        {view.weights.map((one) => (
          <span
            key={one.cls}
            className={`figy-sheet-bar-slice ${CLASS_TINT[one.cls]}`}
            style={{ flexGrow: one.share }}
            title={`${one.cls} — ${formatTokens(one.tokens)} tokens`}
          />
        ))}
      </div>

      <div className="figy-sheet-rows">
        {view.rows.map((row) => (
          <Row
            key={row.name}
            label={row.name}
            note={row.cls}
            value={formatTokens(row.tokens)}
            share={row.share}
            tint={CLASS_TINT[row.cls]}
          />
        ))}
      </div>

      {view.offered && (
        <div className="figy-sheet-verdict good">
          <span className="figy-sheet-verdict-value">{view.offered.count}</span>
          <span className="figy-sheet-verdict-text">
            of {view.count} offered on the last message, narrowed by {view.offered.by} before the
            model was asked — so the definitions it did not need were never sent.
          </span>
        </div>
      )}

      <p className="figy-sheet-note">{view.note}</p>
    </>
  );
}

/**
 * Which tint a tool's class takes.
 *
 * The context screen's own four, because a tool definition is one of
 * the parts those colours already stand for — and what they encode on
 * a tool row is how loudly it asks before acting, which escalates in
 * the same order.
 */
const CLASS_TINT: Record<ToolInfo["class"], string> = {
  read: "user",
  write: "assistant",
  exec: "toolResults",
  net: "imageTokens",
};

/* ─── Earlier ─────────────────────────────────────────────────────────────── */

function ResumeView({
  past,
  onResume,
  onForget,
}: {
  past: Conversation[];
  onResume: (sessionId: string) => void;
  onForget: (sessionId: string) => void;
}) {
  if (past.length === 0) return <Empty>{RESUME_EMPTY}</Empty>;

  return (
    <>
      <ul className="figy-sheet-list">
        {past.map((one) => {
          const row = conversationRow(one);
          return (
            <li key={one.sessionId}>
              <button
                type="button"
                className="figy-sheet-list-row"
                onClick={() => onResume(one.sessionId)}
                title={row.title}
              >
                <span className="figy-sheet-list-title">{row.title}</span>
                <span className="figy-sheet-list-meta">{row.meta}</span>
              </button>
              <button
                type="button"
                className="figy-sheet-icon"
                onClick={() => onForget(one.sessionId)}
                title="Forget this conversation"
                aria-label={`Forget ${row.title}`}
              >
                <Trash2 size={11} />
              </button>
            </li>
          );
        })}
      </ul>

      <p className="figy-sheet-note">{RESUME_NOTE}</p>
    </>
  );
}

/* ─── Model ───────────────────────────────────────────────────────────────── */

/**
 * Which model answers — picking only.
 *
 * Adding one is a provider, a URL, a key, three prices, a context
 * window and whether it reads images: a form, and the window has a
 * table for it. This is the list, and it says where the other thing
 * lives rather than pretending it is not needed.
 */
function ModelView({
  status,
  onPick,
  onTest,
  onNotice,
}: {
  status: AgentStatus;
  onPick: (next: AgentSettings) => void;
  onTest: () => Promise<RouterCheck>;
  onNotice: (notice: Notice) => void;
}) {
  const usable = status.models.filter((m) => m.baseUrl.trim() && m.model.trim());

  if (usable.length === 0) {
    return (
      <Empty>
        No models are set up. Open the FigyCode window and add one in Settings — the panel uses
        the same ones.
      </Empty>
    );
  }

  return (
    <>
      <ul className="figy-sheet-list">
        {usable.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              className={`figy-sheet-list-row ${one.id === status.active ? "on" : ""}`}
              onClick={() => onPick(settingsFrom(status, { active: one.id }))}
              aria-pressed={one.id === status.active}
            >
              <span className="figy-sheet-list-title">
                {one.label}
                {one.vision && <span className="figy-sheet-tag">images</span>}
              </span>
              <span className="figy-sheet-list-meta">{one.model}</span>
            </button>
          </li>
        ))}
      </ul>

      {/*
        The router, where it can actually be checked.

        It is the one setting whose failure is silent by design: a
        router that cannot be reached quietly offers every tool, which
        is right during a turn and makes "narrowed" and "not running"
        look identical from outside.
      */}
      {status.hasRouterKey && (
        <button
          type="button"
          className="figy-sheet-action"
          onClick={() =>
            void onTest()
              .then((check) =>
                onNotice({
                  tone: check.ok ? "info" : "warn",
                  title: check.ok
                    ? `The picker answered — ${check.picked.length} of ${check.total} tools`
                    : "The picker could not be reached",
                  // What it chose, not just how many: the number says
                  // it narrowed and the names say whether it narrowed
                  // to the right ones, which is the actual question.
                  body: check.ok
                    ? `${check.picked.join(", ")} · ${formatCost(check.costUsd)} for the call.`
                    : `${check.error ?? "No answer."} Every tool is offered instead, which costs more and works.`,
                })
              )
              .catch((error: unknown) =>
                onNotice({ tone: "error", title: "That check failed", body: String(error) })
              )
          }
        >
          {status.router ? "Check the tool picker" : "The tool picker is off"}
        </button>
      )}

      <p className="figy-sheet-note">
        One model is shared with the FigyCode window, so picking here changes it there too.
        Setting one up is done in that window.
      </p>
    </>
  );
}

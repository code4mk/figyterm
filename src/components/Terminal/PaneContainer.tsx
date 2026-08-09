import { useRef, useEffect, useState, useCallback } from "react";
import { Panel, Group } from "react-resizable-panels";
import { Terminal } from "./Terminal";
import { SplitHandle } from "./SplitHandle";
import { TerminalSession } from "../../types/terminal";

export type PaneNode =
  | { type: "leaf"; id: string }
  | { type: "split"; direction: "horizontal" | "vertical"; first: PaneNode; second: PaneNode };

export function countPanes(node: PaneNode): number {
  if (node.type === "leaf") return 1;
  return countPanes(node.first) + countPanes(node.second);
}

export function findLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...findLeafIds(node.first), ...findLeafIds(node.second)];
}

export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.id === paneId ? null : node;
  }
  if (node.first.type === "leaf" && node.first.id === paneId) return node.second;
  if (node.second.type === "leaf" && node.second.id === paneId) return node.first;

  const newFirst = removePane(node.first, paneId);
  if (newFirst !== node.first) return newFirst ? { ...node, first: newFirst } : node.second;

  const newSecond = removePane(node.second, paneId);
  if (newSecond !== node.second) return newSecond ? { ...node, second: newSecond } : node.first;

  return node;
}

export function splitPane(
  node: PaneNode,
  paneId: string,
  direction: "horizontal" | "vertical",
  newPaneId: string
): PaneNode {
  if (node.type === "leaf") {
    if (node.id === paneId) {
      return {
        type: "split",
        direction,
        first: { type: "leaf", id: paneId },
        second: { type: "leaf", id: newPaneId },
      };
    }
    return node;
  }
  return {
    ...node,
    first: splitPane(node.first, paneId, direction, newPaneId),
    second: splitPane(node.second, paneId, direction, newPaneId),
  };
}

interface SlotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PaneContainerProps {
  paneTree: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
  onSessionCreated: (paneId: string, session: TerminalSession) => void;
  onCwdChange: (paneId: string, cwd: string) => void;
  clearRefs: React.MutableRefObject<Map<string, React.MutableRefObject<(() => void) | null>>>;
}

export function PaneContainer({
  paneTree,
  activePaneId,
  onPaneFocus,
  onSessionCreated,
  onCwdChange,
  clearRefs,
}: PaneContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const slotRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const [slotRects, setSlotRects] = useState<Record<string, SlotRect>>({});
  const leafIds = findLeafIds(paneTree);
  const hasSiblings = leafIds.length > 1;

  const measureSlots = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const newRects: Record<string, SlotRect> = {};

    slotRefsMap.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect();
      newRects[id] = {
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
      };
    });

    setSlotRects(newRects);
  }, []);

  const registerSlot = useCallback((paneId: string, el: HTMLDivElement | null) => {
    if (el) {
      slotRefsMap.current.set(paneId, el);
    } else {
      slotRefsMap.current.delete(paneId);
    }
    measureSlots();
  }, [measureSlots]);

  useEffect(() => {
    measureSlots();
  }, [paneTree, measureSlots]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measureSlots());
    observer.observe(container);
    slotRefsMap.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [paneTree, measureSlots]);

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {/* Layout tree — invisible sizing structure */}
      <div className="w-full h-full">
        <LayoutTree node={paneTree} registerSlot={registerSlot} />
      </div>

      {/* Terminals — flat layer, positioned absolutely over their slots */}
      {leafIds.map((paneId) => {
        const rect = slotRects[paneId];
        const isActive = paneId === activePaneId;
        let clearRef = clearRefs.current.get(paneId);
        if (!clearRef) {
          clearRef = { current: null };
          clearRefs.current.set(paneId, clearRef);
        }

        return (
          <div
            key={paneId}
            className={`absolute overflow-hidden ${
              hasSiblings
                ? `rounded-md border ${isActive ? "border-ft-accent" : "border-ft-border-subtle/60"}`
                : ""
            }`}
            style={
              rect
                ? hasSiblings
                  ? { top: rect.top + 2, left: rect.left + 4, width: rect.width - 8, height: rect.height - 4 }
                  : { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
                : { top: 0, left: 0, width: 0, height: 0, opacity: 0 }
            }
            onMouseDown={() => onPaneFocus(paneId)}
          >
            <Terminal
              instanceId={paneId}
              isActive={true}
              onSessionCreated={(session) => onSessionCreated(paneId, session)}
              onCwdChange={(cwd) => onCwdChange(paneId, cwd)}
              clearRef={clearRef}
            />
          </div>
        );
      })}
    </div>
  );
}

interface LayoutTreeProps {
  node: PaneNode;
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void;
}

function LayoutTree({ node, registerSlot }: LayoutTreeProps) {
  if (node.type === "leaf") {
    return <PaneSlot paneId={node.id} registerSlot={registerSlot} />;
  }

  return (
    <Group orientation={node.direction} className="w-full h-full">
      <Panel minSize="20%" defaultSize="50%">
        <LayoutTree node={node.first} registerSlot={registerSlot} />
      </Panel>
      <SplitHandle direction={node.direction} />
      <Panel minSize="20%" defaultSize="50%">
        <LayoutTree node={node.second} registerSlot={registerSlot} />
      </Panel>
    </Group>
  );
}

interface PaneSlotProps {
  paneId: string;
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void;
}

function PaneSlot({ paneId, registerSlot }: PaneSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerSlot(paneId, slotRef.current);
    return () => registerSlot(paneId, null);
  }, [paneId, registerSlot]);

  return (
    <div
      ref={slotRef}
      className="w-full h-full"
    />
  );
}

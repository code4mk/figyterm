import { Separator } from "react-resizable-panels";

let _dragging = false;

export function isDragging() {
  return _dragging;
}

function onMouseDown() {
  _dragging = true;
  const onMouseUp = () => {
    _dragging = false;
    window.dispatchEvent(new Event("pane-drag-end"));
    window.removeEventListener("mouseup", onMouseUp);
  };
  window.addEventListener("mouseup", onMouseUp);
}

interface SplitHandleProps {
  direction: "horizontal" | "vertical";
}

export function SplitHandle({ direction }: SplitHandleProps) {
  const isHorizontal = direction === "horizontal";

  return (
    <Separator
      className={`group relative flex items-center justify-center select-none ${
        isHorizontal ? "w-[6px] cursor-col-resize" : "h-[6px] cursor-row-resize"
      }`}
      onMouseDown={onMouseDown}
    >
      <div
        className={`absolute transition-all duration-150 rounded-full ${
          isHorizontal
            ? "w-[2px] h-8 group-hover:h-12 group-hover:w-[3px] group-active:w-[3px] group-active:h-16"
            : "h-[2px] w-8 group-hover:w-12 group-hover:h-[3px] group-active:h-[3px] group-active:w-16"
        } bg-ft-border-subtle group-hover:bg-ft-accent/60 group-active:bg-ft-accent`}
      />
    </Separator>
  );
}

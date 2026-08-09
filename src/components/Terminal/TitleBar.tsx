export function TitleBar() {
  return (
    <div className="drag-region flex items-center h-11 px-4 bg-ft-surface border-b border-ft-border-subtle select-none">
      {/* macOS traffic lights spacing */}
      <div className="w-[70px] flex-shrink-0" />

      <div className="flex-1 flex items-center justify-center">
        <span className="text-[11px] font-medium text-ft-text-muted tracking-wide uppercase">
          Figyterm
        </span>
      </div>

      <div className="w-[70px] flex-shrink-0" />
    </div>
  );
}

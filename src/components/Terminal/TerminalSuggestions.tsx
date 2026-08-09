import { Suggestion } from "../../types/autocomplete";

interface TerminalSuggestionsProps {
  suggestions: Suggestion[];
  isVisible: boolean;
  selectedIndex: number;
  onSelect: (suggestion: Suggestion) => void;
}

// Phase 2 placeholder component
export function TerminalSuggestions({
  suggestions,
  isVisible,
  selectedIndex,
  onSelect,
}: TerminalSuggestionsProps) {
  if (!isVisible || suggestions.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 w-80 max-h-60 overflow-y-auto bg-terminal-surface border border-terminal-border rounded-lg shadow-xl z-50">
      {suggestions.map((suggestion, idx) => (
        <div
          key={suggestion.label}
          className={`px-3 py-2 cursor-pointer transition-colors ${
            idx === selectedIndex
              ? "bg-terminal-accent/20 text-terminal-text"
              : "text-terminal-muted hover:bg-terminal-border/50 hover:text-terminal-text"
          }`}
          onClick={() => onSelect(suggestion)}
        >
          <div className="text-sm font-medium">{suggestion.label}</div>
          {suggestion.description && (
            <div className="text-xs text-terminal-muted mt-0.5">{suggestion.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}

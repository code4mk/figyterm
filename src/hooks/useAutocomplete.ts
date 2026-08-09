import { useState } from "react";
import { Suggestion } from "../types/autocomplete";

// Placeholder for Phase 2 autocomplete hook
export function useAutocomplete() {
  const [suggestions] = useState<Suggestion[]>([]);
  const [isVisible] = useState(false);

  return {
    suggestions,
    isVisible,
  };
}

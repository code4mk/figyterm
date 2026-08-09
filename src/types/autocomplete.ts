export interface Suggestion {
  label: string;
  description?: string;
  type: SuggestionType;
  insertText: string;
}

export type SuggestionType =
  | "command"
  | "subcommand"
  | "option"
  | "file"
  | "directory"
  | "branch"
  | "history";

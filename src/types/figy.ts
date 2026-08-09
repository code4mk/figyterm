/**
 * Autocomplete Spec Type Definitions
 * Compatible with withfig/autocomplete spec format.
 *
 * These types allow loading community-maintained autocomplete specs
 * directly into Figyterm's autocomplete engine.
 */

export namespace Figy {
  export type TemplateStrings = "filepaths" | "folders" | "history";
  export type Template = TemplateStrings | TemplateStrings[];

  export interface BaseSuggestion {
    displayName?: string;
    insertValue?: string;
    description?: string;
    icon?: string;
    priority?: number;
    hidden?: boolean;
    deprecated?: boolean | Deprecation;
  }

  export interface Deprecation {
    insertValue?: string;
    description?: string;
  }

  export interface Suggestion extends BaseSuggestion {
    name: string | string[];
    type?: SuggestionType;
  }

  export type SuggestionType =
    | "folder"
    | "file"
    | "arg"
    | "subcommand"
    | "option"
    | "special"
    | "mixin"
    | "shortcut";

  export interface CacheStrategy {
    strategy?: "stale-while-revalidate" | "max-age";
    ttl?: number;
    cacheByDirectory?: boolean;
  }

  export interface ExecuteShellCommandInput {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }

  export interface ExecuteShellCommandOutput {
    stdout: string;
    stderr: string;
    status: number;
  }

  export type ExecuteShellCommandFunction = (
    input: ExecuteShellCommandInput
  ) => Promise<ExecuteShellCommandOutput>;

  export interface Generator {
    script?: string[] | ((tokens: string[]) => string[]);
    postProcess?: (out: string, tokens: string[]) => Suggestion[];
    splitOn?: string;
    custom?: (
      tokens: string[],
      executeShellCommand: ExecuteShellCommandFunction,
      context?: GeneratorContext
    ) => Promise<(Suggestion | undefined | null)[]>;
    cache?: CacheStrategy;
    trigger?: string | ((newToken: string, oldToken: string) => boolean);
    getQueryTerm?: string | ((token: string) => string);
    filterTerm?: string | ((token: string) => string);
    template?: Template;
  }

  export interface GeneratorContext {
    environmentVariables?: Record<string, string>;
    currentWorkingDirectory?: string;
    currentProcess?: string;
    sshPrefix?: string;
    isDangerous?: boolean;
    searchTerm?: string;
  }

  export interface Arg {
    name?: string;
    description?: string;
    default?: string;
    isVariadic?: boolean;
    isOptional?: boolean;
    isCommand?: boolean;
    isModule?: boolean;
    isScript?: boolean;
    optionsCanBreakVariadicArg?: boolean;
    parserDirectives?: ParserDirectives;
    template?: Template;
    generators?: Generator | Generator[];
    suggestions?: (string | Suggestion)[];
    loadSpec?: string | ((token: string, exec: ExecuteShellCommandFunction) => Promise<Spec>);
    filterStrategy?: "fuzzy" | "prefix" | "default";
    debounce?: boolean;
    isDangerous?: boolean;
  }

  export interface Option extends BaseSuggestion {
    name: string | string[];
    args?: Arg | Arg[];
    isPersistent?: boolean;
    isRequired?: boolean;
    isRepeatable?: boolean | number;
    requiresSeparator?: boolean | string;
    requiresEquals?: boolean;
    exclusiveOn?: string[];
    dependsOn?: string[];
  }

  export interface Subcommand extends BaseSuggestion {
    name: string | string[];
    subcommands?: Subcommand[];
    options?: Option[];
    args?: Arg | Arg[];
    generateSpec?: (
      tokens: string[],
      executeShellCommand: ExecuteShellCommandFunction
    ) => Promise<Spec>;
    loadSpec?: string | ((token: string, exec: ExecuteShellCommandFunction) => Promise<Spec>);
    parserDirectives?: ParserDirectives;
    filterStrategy?: "fuzzy" | "prefix" | "default";
    cache?: CacheStrategy;
    additionalSuggestions?: (string | Suggestion)[];
  }

  export interface ParserDirectives {
    optionsMustPrecedeArguments?: boolean;
    optionArgSeparators?: string | string[];
    flagsArePosixNoncompliant?: boolean;
    alias?: string | ((token: string) => string | null);
  }

  export interface Spec extends Subcommand {
    name: string | string[];
  }

  export type SpecLocation = {
    type: "local" | "global" | "builtin";
    path: string;
    name: string;
  };
}

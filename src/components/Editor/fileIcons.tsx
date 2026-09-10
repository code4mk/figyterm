import {
  File,
  FileCode2,
  FileCog,
  FileDiff,
  FileImage,
  FileJson2,
  FileLock2,
  FileTerminal,
  FileText,
  FileType,
} from "lucide-react";
import { languageFor } from "../../services/editor-lang";
import { basename } from "../../services/editor-fs";

/**
 * An icon and a colour per file, so the tree can be read by shape.
 *
 * Deliberately a handful of categories rather than one icon per technology: a
 * full icon theme is a few hundred SVGs and a licence to check, and at 13px the
 * thing that actually helps is telling code from config from documentation at a
 * glance. Colours come from the palette in `styles.css` via the `editor-icon-*`
 * classes.
 */

type IconComponent = typeof File;

interface IconSpec {
  Icon: IconComponent;
  className: string;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "icns",
  "tiff",
]);

const LOCK_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "poetry.lock",
  "bun.lockb",
  "composer.lock",
  "gemfile.lock",
]);

const BY_LANGUAGE: Record<string, IconSpec> = {
  javascript: { Icon: FileCode2, className: "editor-icon-js" },
  typescript: { Icon: FileCode2, className: "editor-icon-ts" },
  tsx: { Icon: FileCode2, className: "editor-icon-ts" },
  json: { Icon: FileJson2, className: "editor-icon-data" },
  css: { Icon: FileType, className: "editor-icon-style" },
  html: { Icon: FileCode2, className: "editor-icon-markup" },
  xml: { Icon: FileCode2, className: "editor-icon-markup" },
  markdown: { Icon: FileText, className: "editor-icon-doc" },
  python: { Icon: FileCode2, className: "editor-icon-python" },
  rust: { Icon: FileCode2, className: "editor-icon-rust" },
  go: { Icon: FileCode2, className: "editor-icon-go" },
  java: { Icon: FileCode2, className: "editor-icon-java" },
  cpp: { Icon: FileCode2, className: "editor-icon-cpp" },
  php: { Icon: FileCode2, className: "editor-icon-php" },
  ruby: { Icon: FileCode2, className: "editor-icon-ruby" },
  lua: { Icon: FileCode2, className: "editor-icon-lua" },
  swift: { Icon: FileCode2, className: "editor-icon-swift" },
  shell: { Icon: FileTerminal, className: "editor-icon-shell" },
  powershell: { Icon: FileTerminal, className: "editor-icon-shell" },
  yaml: { Icon: FileCog, className: "editor-icon-config" },
  toml: { Icon: FileCog, className: "editor-icon-config" },
  ini: { Icon: FileCog, className: "editor-icon-config" },
  dockerfile: { Icon: FileCog, className: "editor-icon-docker" },
  diff: { Icon: FileDiff, className: "editor-icon-diff" },
  plaintext: { Icon: File, className: "editor-icon-plain" },
};

export function fileIconFor(path: string): IconSpec {
  const name = basename(path).toLowerCase();

  if (LOCK_FILES.has(name)) {
    return { Icon: FileLock2, className: "editor-icon-plain" };
  }

  const dot = name.lastIndexOf(".");
  if (dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1))) {
    return { Icon: FileImage, className: "editor-icon-image" };
  }

  return BY_LANGUAGE[languageFor(path)] ?? BY_LANGUAGE.plaintext;
}

/** The icon for a file, sized for a tree row or a tab. */
export function FileIcon({ path, size = 13 }: { path: string; size?: number }) {
  const { Icon, className } = fileIconFor(path);
  return <Icon size={size} className={`shrink-0 ${className}`} />;
}

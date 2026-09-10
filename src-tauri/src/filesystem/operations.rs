//! Filesystem operations behind the embedded editor.
//!
//! Everything here takes a `&Path` that has already been checked against the
//! open workspace roots — the confinement itself lives in `commands/fs.rs`,
//! because it needs the state the frontend registers roots in. Nothing in this
//! module reaches for `AppHandle` or emits events, so it stays testable and the
//! IPC surface stays thin.

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

/// Above this a file still opens, but read-only and without highlighting: a
/// 20 MB minified bundle will parse, it just takes long enough that the modal
/// looks hung while it does.
pub const LARGE_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Above this it doesn't open at all. There is no version of loading a 50 MB
/// file into a text editor in a terminal that ends well; the explorer offers
/// "reveal in Finder" instead.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// How much of a file is examined to decide whether it's text.
const SNIFF_BYTES: usize = 8192;

/// Files bigger than this are skipped by project search. Anything larger is a
/// build artefact or a dataset, and reading it stalls the walk for every other
/// file behind it.
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// A matched line is sent to the UI trimmed to this, so one minified line can't
/// push a megabyte through the event channel.
const SEARCH_MAX_LINE_CHARS: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Epoch millis. The editor compares this against the value a buffer was
    /// loaded at to notice someone else writing the file.
    pub mtime: u64,
    pub readonly: bool,
}

/// What kind of thing `read_text_file` found.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Text,
    Binary,
    TooLarge,
    /// Nothing there. Reported as an outcome rather than an error so the editor
    /// can say "not found" in its own words, instead of relaying a localised
    /// `No such file or directory (os error 2)` to the user.
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum LineEnding {
    #[serde(rename = "lf")]
    Lf,
    #[serde(rename = "crlf")]
    Crlf,
}

/// Only the encodings a BOM can identify, plus plain UTF-8.
///
/// Anything else — a Latin-1 file with a high byte in it, say — fails the UTF-8
/// decode and is reported as binary rather than opened and silently mangled on
/// the way back out. Guessing at legacy codepages is a feature, not a default.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
}

/// One struct rather than a tagged enum, so `kind` can be switched on in
/// TypeScript without the frontend having to know serde's representation.
/// Everything after `readonly` is meaningful only when `kind` is `text`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub kind: FileKind,
    pub size: u64,
    pub mtime: u64,
    pub readonly: bool,
    /// Normalised to `\n` regardless of what's on disk; `line_ending` records
    /// what to write back.
    pub content: String,
    pub encoding: Encoding,
    pub line_ending: LineEnding,
    /// Opened without highlighting because of its size.
    pub large: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
    pub include_hidden: bool,
    /// Search inside `.gitignore`d paths too. Off by default, which is what
    /// keeps `node_modules` out of the results.
    pub include_ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    /// 1-based, so it can be handed straight to "go to line".
    pub line: u32,
    /// 0-based index into `text`, for highlighting the hit in the panel.
    pub column: u32,
    /// 0-based column in the source line, for putting the cursor on it.
    ///
    /// Distinct from `column` because `text` is only a window around the match
    /// on a long line — the two agree on every line short enough to be shown
    /// whole, and using one for the other sent "go to" to the wrong place on
    /// exactly the lines where being precise matters.
    pub line_column: u32,
    pub length: u32,
    /// The matched line, trimmed. `column` is an index into this.
    pub text: String,
}

// ─── Hidden files ───────────────────────────────────────────────────────────

/// Whether the explorer should hide this entry by default.
///
/// A leading dot is the POSIX convention and means nothing to Windows, which
/// carries hidden as a file attribute instead — so `AppData` and `$Recycle.Bin`
/// looked like ordinary directories while `.gitignore` was hidden, which is
/// exactly backwards from what a Windows user expects. Both rules apply on
/// Windows: dotfiles are still hidden there, because the projects people open
/// in this editor are full of them.
pub fn is_hidden(path: &Path, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        if let Ok(meta) = path.metadata() {
            let attrs = meta.file_attributes();
            return attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0;
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = path;

    false
}

fn mtime_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The mtime of a path right now, or `None` if it doesn't exist.
///
/// Used by the save path to decide whether the file changed under the buffer.
pub fn mtime_of(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| mtime_millis(&m))
}

fn entry_from(path: &Path, name: String, meta: &fs::Metadata, is_symlink: bool) -> FileEntry {
    FileEntry {
        is_hidden: is_hidden(path, &name),
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: meta.is_dir(),
        is_symlink,
        size: meta.len(),
        mtime: mtime_millis(meta),
        readonly: meta.permissions().readonly(),
    }
}

// ─── Reading directories ────────────────────────────────────────────────────

pub fn list_directory(path: &Path, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let read_dir =
        fs::read_dir(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        // One unreadable entry shouldn't fail the whole listing — a directory
        // with a broken symlink or a permission-denied child is still worth
        // showing the rest of.
        let Ok(entry) = entry else { continue };
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let is_symlink = entry
            .file_type()
            .map(|t| t.is_symlink())
            .unwrap_or(false);

        // `metadata()` follows symlinks, which is what we want: a link to a
        // directory should expand like one.
        let Ok(meta) = fs::metadata(&entry_path) else {
            // A dangling symlink has no target metadata. Still list it, so the
            // user can see and delete it.
            let Ok(meta) = entry.metadata() else { continue };
            let info = entry_from(&entry_path, name, &meta, true);
            if show_hidden || !info.is_hidden {
                entries.push(info);
            }
            continue;
        };

        let info = entry_from(&entry_path, name, &meta, is_symlink);
        if show_hidden || !info.is_hidden {
            entries.push(info);
        }
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}

pub fn stat(path: &Path) -> Result<FileEntry, String> {
    let meta =
        fs::metadata(path).map_err(|e| format!("Could not stat {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let is_symlink = fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    Ok(entry_from(path, name, &meta, is_symlink))
}

// ─── Reading files ──────────────────────────────────────────────────────────

/// Whether `bytes` look like something other than text.
///
/// A NUL byte is the classic signal and the one every other tool uses — no text
/// encoding we open produces one, and every binary format has them early.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0)
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

pub fn read_text_file(path: &Path) -> Result<OpenedFile, String> {
    if !path.exists() {
        return Ok(OpenedFile {
            kind: FileKind::Missing,
            size: 0,
            mtime: 0,
            readonly: false,
            content: String::new(),
            encoding: Encoding::Utf8,
            line_ending: LineEnding::Lf,
            large: false,
        });
    }

    let meta =
        fs::metadata(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }

    let size = meta.len();
    let mtime = mtime_millis(&meta);
    let readonly = meta.permissions().readonly();

    let mut file = OpenedFile {
        kind: FileKind::TooLarge,
        size,
        mtime,
        readonly,
        content: String::new(),
        encoding: Encoding::Utf8,
        line_ending: LineEnding::Lf,
        large: size > LARGE_FILE_BYTES,
    };

    if size > MAX_FILE_BYTES {
        return Ok(file);
    }

    let mut bytes = Vec::with_capacity(size as usize);
    File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;

    // BOM first: a UTF-16 file is full of NULs and would otherwise sniff as
    // binary, and a UTF-8 BOM has to come off the front before the text is
    // handed to the editor or it shows up as a stray glyph on line 1.
    let (encoding, decoded) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (
            Encoding::Utf8Bom,
            String::from_utf8(bytes[3..].to_vec()).ok(),
        )
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (Encoding::Utf16Le, Some(decode_utf16(&bytes[2..], true)))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (Encoding::Utf16Be, Some(decode_utf16(&bytes[2..], false)))
    } else if looks_binary(&bytes) {
        (Encoding::Utf8, None)
    } else {
        (Encoding::Utf8, String::from_utf8(bytes.clone()).ok())
    };

    let Some(text) = decoded else {
        file.kind = FileKind::Binary;
        return Ok(file);
    };

    file.kind = FileKind::Text;
    file.encoding = encoding;
    file.line_ending = if text.contains("\r\n") {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    // CodeMirror is given `\n` throughout; `line_ending` is what puts the
    // file back the way it was found. Getting this wrong is how an editor
    // turns a one-line change into a whole-file diff on Windows.
    file.content = if file.line_ending == LineEnding::Crlf {
        text.replace("\r\n", "\n")
    } else {
        text
    };

    Ok(file)
}

// ─── Writing files ──────────────────────────────────────────────────────────

fn encode(content: &str, encoding: Encoding, line_ending: LineEnding) -> Vec<u8> {
    let text = if line_ending == LineEnding::Crlf {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    };

    match encoding {
        Encoding::Utf8 => text.into_bytes(),
        Encoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            out
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let big_endian = encoding == Encoding::Utf16Be;
            let mut out = if big_endian {
                vec![0xFE, 0xFF]
            } else {
                vec![0xFF, 0xFE]
            };
            for unit in text.encode_utf16() {
                let pair = if big_endian {
                    unit.to_be_bytes()
                } else {
                    unit.to_le_bytes()
                };
                out.extend_from_slice(&pair);
            }
            out
        }
    }
}

/// Writes `content` to `path` without ever leaving a half-written file there.
///
/// A plain `File::create` truncates immediately, so a crash — or a full disk —
/// between that and the last write leaves the user with nothing. Writing a
/// sibling temp file and renaming it over the target makes the replacement
/// atomic on every platform we ship: POSIX `rename` is atomic by specification,
/// and Rust's `fs::rename` on Windows passes `MOVEFILE_REPLACE_EXISTING`.
///
/// Returns the mtime of the file as it now stands, which the editor keeps for
/// the next conflict check.
pub fn write_text_file(
    path: &Path,
    content: &str,
    encoding: Encoding,
    line_ending: LineEnding,
) -> Result<u64, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("{} is not a file path", path.display()))?;

    // Same directory as the target, so the rename can't cross a filesystem
    // boundary — which would make it a copy, and no longer atomic.
    let temp = parent.join(format!(".{name}.figytmp"));

    let bytes = encode(content, encoding, line_ending);
    let write = File::create(&temp).and_then(|mut f| {
        f.write_all(&bytes)?;
        // Without this the rename can land before the data does, and a power
        // loss leaves a present but empty file.
        f.sync_all()
    });

    if let Err(e) = write {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not write {}: {e}", path.display()));
    }

    // Keep the original file's mode; a fresh temp file gets the process umask,
    // which would quietly widen permissions on anything deliberately locked down.
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp, meta.permissions());
    }

    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not replace {}: {e}", path.display()));
    }

    Ok(mtime_of(path).unwrap_or(0))
}

// ─── Mutating the tree ──────────────────────────────────────────────────────

pub fn create(path: &Path, is_dir: bool) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if is_dir {
        return fs::create_dir_all(path)
            .map_err(|e| format!("Could not create {}: {e}", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    File::create(path)
        .map(|_| ())
        .map_err(|e| format!("Could not create {}: {e}", path.display()))
}

pub fn rename(from: &Path, to: &Path) -> Result<(), String> {
    // Without this a rename that only changes case (`Cta.tsx` → `cta.tsx`) is
    // refused on macOS and Windows, and one onto an existing sibling silently
    // destroys it.
    let same_path_different_case = from
        .to_string_lossy()
        .eq_ignore_ascii_case(&to.to_string_lossy());
    if to.exists() && !same_path_different_case {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    fs::rename(from, to).map_err(|e| format!("Could not rename {}: {e}", from.display()))
}

/// Deletes a path, preferring the platform trash.
///
/// `to_trash` is what the explorer asks for; the caller is expected to have
/// said "delete permanently" in its prompt when it passes `false`. If the trash
/// isn't available (some Linux setups have none), the error is returned rather
/// than falling through to an unrecoverable delete the user didn't agree to.
pub fn delete(path: &Path, to_trash: bool) -> Result<(), String> {
    if to_trash {
        return trash::delete(path)
            .map_err(|e| format!("Could not move {} to the trash: {e}", path.display()));
    }
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Could not delete {}: {e}", path.display()))
    } else {
        fs::remove_file(path).map_err(|e| format!("Could not delete {}: {e}", path.display()))
    }
}

// ─── Searching ──────────────────────────────────────────────────────────────

fn build_matcher(query: &str, opts: &SearchOptions) -> Result<Regex, String> {
    let pattern = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if opts.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };

    RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .size_limit(1 << 22)
        .build()
        .map_err(|e| format!("Bad search pattern: {e}"))
}

/// Trims a long line down to a window around the match.
///
/// Returns the text to show and the match's column within it. Char boundaries
/// matter here: slicing a UTF-8 string by byte offset mid-codepoint panics.
fn window_around(line: &str, start: usize, end: usize) -> (String, u32) {
    if line.chars().count() <= SEARCH_MAX_LINE_CHARS {
        let column = line[..start].chars().count() as u32;
        return (line.to_string(), column);
    }

    let match_chars = line[..start].chars().count();
    let lead = match_chars.saturating_sub(60);
    let take = SEARCH_MAX_LINE_CHARS;

    let text: String = line.chars().skip(lead).take(take).collect();
    let _ = end;
    (text, (match_chars - lead) as u32)
}

/// Every file under `root`, as paths relative to it.
///
/// This is what the quick-open finder filters. It's a full walk, so it respects
/// `.gitignore` — the alternative is offering the user a fuzzy list of
/// `node_modules` — and it's capped, because a fuzzy matcher over 200,000 paths
/// is not fast enough to type into and the honest response is to say the list
/// was truncated.
///
/// Relative paths, not absolute: they're both what the UI shows and a
/// meaningful fraction of the payload on a large repo.
pub fn list_files(root: &Path, limit: usize, include_hidden: bool) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut truncated = false;

    let walker = WalkBuilder::new(root)
        .hidden(!include_hidden)
        .follow_links(false)
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        if files.len() >= limit {
            truncated = true;
            break;
        }
        if let Ok(relative) = entry.path().strip_prefix(root) {
            files.push(relative.to_string_lossy().to_string());
        }
    }

    (files, truncated)
}

/// Walks `root` and reports every match, calling `on_match` as it goes.
///
/// The callback returns `false` to stop the walk, which is how a superseded or
/// cancelled search stops burning IO on results nobody will see. Results stream
/// rather than accumulate: a search across a big repo produces its first
/// results in milliseconds and the UI shows them while the rest arrives.
pub fn search_files(
    root: &Path,
    query: &str,
    opts: &SearchOptions,
    on_match: &mut dyn FnMut(SearchMatch) -> bool,
) -> Result<(), String> {
    if query.is_empty() {
        return Ok(());
    }
    let matcher = build_matcher(query, opts)?;

    let walker = WalkBuilder::new(root)
        .hidden(!opts.include_hidden)
        .git_ignore(!opts.include_ignored)
        .git_global(!opts.include_ignored)
        .git_exclude(!opts.include_ignored)
        // Symlinked directories are not followed: a link back up the tree turns
        // the walk into an infinite one.
        .follow_links(false)
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }

        let path = entry.path();
        let Ok(meta) = path.metadata() else { continue };
        if meta.len() > SEARCH_MAX_FILE_BYTES {
            continue;
        }

        let mut bytes = Vec::with_capacity(meta.len() as usize);
        if File::open(path)
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .is_err()
        {
            continue;
        }
        if looks_binary(&bytes) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };

        let path_str = path.to_string_lossy().to_string();
        for (index, line) in text.lines().enumerate() {
            for hit in matcher.find_iter(line) {
                let (shown, column) = window_around(line, hit.start(), hit.end());
                let keep_going = on_match(SearchMatch {
                    path: path_str.clone(),
                    line: index as u32 + 1,
                    column,
                    // Counted in chars, not bytes: the editor's columns are
                    // character offsets, and a line with any multi-byte
                    // character in front of the match would land short.
                    line_column: line[..hit.start()].chars().count() as u32,
                    length: line[hit.start()..hit.end()].chars().count() as u32,
                    text: shown,
                });
                if !keep_going {
                    return Ok(());
                }
            }
        }
    }

    Ok(())
}

// ─── Home directory ─────────────────────────────────────────────────────────

pub fn get_home_dir() -> Option<String> {
    dirs_next().or_else(|| std::env::var("HOME").ok())
}

fn dirs_next() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok()
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("HOME").ok()
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        std::env::var("HOME").ok()
    }
}

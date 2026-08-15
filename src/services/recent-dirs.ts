const STORAGE_KEY = "figyterm-recent-dirs";
const MAX_ENTRIES = 30;
const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface RecentEntry {
  path: string;
  count: number;
  lastUsed: number;
}

let _homeDir = "";

export function setHomeDir(home: string) {
  _homeDir = home;
}

function normalize(p: string): string {
  if (!p) return p;
  let resolved = p;
  if (resolved.startsWith("~/") && _homeDir) {
    resolved = _homeDir + resolved.slice(1);
  } else if (resolved === "~" && _homeDir) {
    resolved = _homeDir;
  }
  // Strip trailing slash for consistent comparison (unless root "/")
  if (resolved.length > 1 && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentEntry[];
  } catch {
    return [];
  }
}

function save(entries: RecentEntry[]) {
  const now = Date.now();
  const fresh = entries
    .filter((e) => now - e.lastUsed < EXPIRE_MS)
    .slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
}

export function recordDirUsage(dirPath: string) {
  if (!dirPath || dirPath === "." || dirPath === "..") return;
  const abs = normalize(dirPath);
  const entries = load();
  const existing = entries.find((e) => e.path === abs);
  if (existing) {
    existing.count = Math.min(existing.count + 1, 50);
    existing.lastUsed = Date.now();
  } else {
    entries.push({ path: abs, count: 1, lastUsed: Date.now() });
  }
  entries.sort((a, b) => b.lastUsed - a.lastUsed);
  save(entries);
}

const SEEDED_KEY = "figyterm-recent-dirs-seeded";

export async function seedFromHistory(): Promise<void> {
  if (localStorage.getItem(SEEDED_KEY)) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const script = [
      "cat ~/.zsh_history 2>/dev/null | sed -n 's/^.*;//p' | grep -E '^cd ' | sed 's/^cd //'",
      "cat ~/.bash_history 2>/dev/null | grep -E '^cd ' | sed 's/^cd //'"
    ].join(" ; ");

    const result = await invoke<{ stdout: string; status: number }>("execute_shell_command", {
      command: "sh",
      args: ["-c", script],
      cwd: null,
    });

    if (result.stdout && result.stdout.trim()) {
      const lines = result.stdout.trim().split("\n");
      const dirCount = new Map<string, number>();

      for (const line of lines) {
        let dir = line.trim();
        if (!dir || dir === "." || dir === ".." || dir === "~" || dir === "-") continue;
        if ((dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'"))) {
          dir = dir.slice(1, -1);
        }
        const abs = normalize(dir);
        if (!abs) continue;
        dirCount.set(abs, (dirCount.get(abs) || 0) + 1);
      }

      const entries = load();
      const now = Date.now();

      for (const [path, count] of dirCount) {
        if (entries.find((e) => e.path === path)) continue;
        entries.push({ path, count: Math.min(count, 20), lastUsed: now - 3600000 });
      }

      entries.sort((a, b) => b.count - a.count);
      save(entries);
    }

    localStorage.setItem(SEEDED_KEY, "1");
  } catch {
    // Don't mark as seeded on failure — will retry next launch
  }
}

export function sortByRecency<T extends { path?: string; name?: string }>(
  items: T[],
  parentDir: string
): T[] {
  const entries = load();
  if (entries.length === 0) return items;

  const now = Date.now();
  const scoreMap = new Map<string, number>();

  for (const entry of entries) {
    const age = (now - entry.lastUsed) / 3600000;
    const score = entry.count * 10 + Math.max(0, 100 - age);
    scoreMap.set(entry.path, score);
  }

  const normParent = normalize(parentDir);

  return [...items].sort((a, b) => {
    const rawA = a.path || (normParent ? `${normParent}/${a.name}` : a.name || "");
    const rawB = b.path || (normParent ? `${normParent}/${b.name}` : b.name || "");
    const pathA = normalize(rawA);
    const pathB = normalize(rawB);
    const scoreA = scoreMap.get(pathA) || 0;
    const scoreB = scoreMap.get(pathB) || 0;

    if (scoreA > 0 || scoreB > 0) {
      return scoreB - scoreA;
    }
    return 0;
  });
}

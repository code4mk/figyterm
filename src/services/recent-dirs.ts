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
  if (p.startsWith("~/") && _homeDir) {
    return _homeDir + p.slice(1);
  }
  if (p === "~" && _homeDir) {
    return _homeDir;
  }
  return p;
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

export function sortByRecency<T extends { path?: string; name?: string }>(
  items: T[],
  parentDir: string
): T[] {
  const entries = load();
  if (entries.length === 0) return items;

  const now = Date.now();
  const scoreMap = new Map<string, number>();

  for (const entry of entries) {
    const score = entry.count * 10 + Math.max(0, 100 - (now - entry.lastUsed) / 3600000);
    scoreMap.set(entry.path, score);
  }

  const normParent = normalize(parentDir);

  return [...items].sort((a, b) => {
    const pathA = a.path || (normParent ? `${normParent}/${a.name}` : a.name || "");
    const pathB = b.path || (normParent ? `${normParent}/${b.name}` : b.name || "");
    const scoreA = scoreMap.get(pathA) || 0;
    const scoreB = scoreMap.get(pathB) || 0;

    if (scoreA > 0 || scoreB > 0) {
      return scoreB - scoreA;
    }
    return 0;
  });
}

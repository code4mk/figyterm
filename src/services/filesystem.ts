export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
}

// Placeholder for Phase 2 filesystem operations
export async function listDirectory(_path: string): Promise<FileEntry[]> {
  return [];
}

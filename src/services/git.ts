import { GitStatus } from "../types/git";

// Placeholder for Phase 2 git operations
export async function getGitStatus(_cwd: string): Promise<GitStatus> {
  return {
    isRepo: false,
    branch: null,
    modifiedFiles: [],
    untrackedFiles: [],
  };
}

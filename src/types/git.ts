export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  modifiedFiles: string[];
  untrackedFiles: string[];
}

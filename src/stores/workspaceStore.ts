import { create } from "zustand";

interface WorkspaceStore {
  currentDirectory: string;
  setCurrentDirectory: (dir: string) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  currentDirectory: "",
  setCurrentDirectory: (dir: string) => set({ currentDirectory: dir }),
}));

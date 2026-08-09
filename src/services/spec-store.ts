import { invoke } from "@tauri-apps/api/core";

const REPO_BASE = "https://raw.githubusercontent.com/code4mk/figy-specs/main";

export interface RemoteSpecEntry {
  name: string;
  description: string;
  category: string;
  icon: boolean;
}

export interface RegistryData {
  version: number;
  specs: RemoteSpecEntry[];
}

export interface InstalledSpec {
  name: string;
  fileSize: number;
  hasIcon: boolean;
}

export async function fetchRegistry(): Promise<RegistryData> {
  const res = await fetch(`${REPO_BASE}/registry.json`);
  if (!res.ok) throw new Error(`Failed to fetch registry: ${res.status}`);
  return res.json();
}

export async function fetchSpecContent(name: string): Promise<string> {
  const res = await fetch(`${REPO_BASE}/specs/${name}.ts`);
  if (!res.ok) throw new Error(`Failed to fetch spec ${name}: ${res.status}`);
  return res.text();
}

export async function fetchSpecIcon(name: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`${REPO_BASE}/icons/${name}.png`);
    if (!res.ok) return null;
    return res.arrayBuffer();
  } catch {
    return null;
  }
}

export async function installSpec(name: string): Promise<void> {
  const content = await fetchSpecContent(name);
  await invoke("save_spec_file", { name, content });

  const iconData = await fetchSpecIcon(name);
  if (iconData) {
    const data = Array.from(new Uint8Array(iconData));
    await invoke("save_spec_icon", { name, data });
  }
}

export async function removeSpec(name: string): Promise<void> {
  await invoke("remove_spec", { name });
}

export async function listInstalledSpecs(): Promise<InstalledSpec[]> {
  return invoke<InstalledSpec[]>("list_installed_specs");
}

export async function readSpecFile(name: string): Promise<string> {
  return invoke<string>("read_spec_file", { name });
}

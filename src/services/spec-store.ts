import { invoke } from "@tauri-apps/api/core";

const REPO_BASE = "https://raw.githubusercontent.com/code4mk/figy-specs/main";

export interface RemoteSpecEntry {
  name: string;
  description: string;
  category: string;
  icon: boolean;
  subSpecs?: string[];
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

/**
 * Fetch a spec file from the remote repo.
 * Supports folder-style paths: "aws" -> specs/aws.ts, "aws/s3" -> specs/aws/s3.ts
 */
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

/**
 * Parse a spec file to extract loadSpec references.
 * Returns an array of sub-spec paths (e.g., ["aws/s3", "aws/ec2"]).
 */
function extractLoadSpecPaths(content: string): string[] {
  const paths: string[] = [];
  const regex = /loadSpec:\s*["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Install a spec and all its sub-specs (referenced via loadSpec).
 * For example, installing "aws" will also fetch aws/s3.ts, aws/ec2.ts, etc.
 */
export async function installSpec(
  name: string,
  onProgress?: (message: string) => void
): Promise<void> {
  onProgress?.(`Fetching ${name}...`);
  const content = await fetchSpecContent(name);
  await invoke("save_spec_file", { name, content });

  // Fetch icon for the root spec
  const iconData = await fetchSpecIcon(name);
  if (iconData) {
    const data = Array.from(new Uint8Array(iconData));
    await invoke("save_spec_icon", { name, data });
  }

  // Find and install sub-specs referenced via loadSpec
  const subPaths = extractLoadSpecPaths(content);
  if (subPaths.length > 0) {
    onProgress?.(`Installing ${subPaths.length} sub-specs for ${name}...`);
    const results = await Promise.allSettled(
      subPaths.map(async (subPath) => {
        try {
          const subContent = await fetchSpecContent(subPath);
          await invoke("save_spec_file", { name: subPath, content: subContent });

          // Recursively check sub-specs (e.g., deeply nested commands)
          const nestedPaths = extractLoadSpecPaths(subContent);
          if (nestedPaths.length > 0) {
            await Promise.allSettled(
              nestedPaths.map(async (nested) => {
                try {
                  const nestedContent = await fetchSpecContent(nested);
                  await invoke("save_spec_file", { name: nested, content: nestedContent });
                } catch {
                  // Sub-spec might not exist; not critical
                }
              })
            );
          }
        } catch {
          // Sub-spec might not exist in the repo; not critical
        }
      })
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    onProgress?.(`Installed ${name} with ${succeeded}/${subPaths.length} sub-specs`);
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

import { getVersion } from "@tauri-apps/api/app";

/** Package metadata is the only authority; failure never invents an installed version. */
export async function loadInstalledVersion(): Promise<string | undefined> {
  try {
    const version = (await getVersion()).trim();
    if (version.length === 0) throw new Error("Empty runtime package version");
    return version;
  } catch (error) {
    console.warn("Installed Modeleaf version is unavailable.", error);
    return undefined;
  }
}

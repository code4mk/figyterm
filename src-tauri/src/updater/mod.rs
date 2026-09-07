//! Update discovery against GitHub Releases.
//!
//! This is deliberately *discovery only* — it tells the user a new version exists
//! and hands them a download URL. It does not install anything. FigyTerm ships
//! unsigned, so the install itself still goes through the DMG + `xattr` flow that
//! the UI explains. See `docs/UPDATE-SYSTEM.md`.

use std::cmp::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

const REPO: &str = "code4mk/figyterm";
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Prerelease,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateStatus {
    UpToDate,
    UpdateAvailable,
    /// The installed version is *newer* than anything released. This is the normal
    /// state for a local dev build, and is not an error.
    DevBuild,
}

/// Whether this particular install can be replaced in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallMethod {
    /// Tauri's updater can swap the running bundle: a macOS `.app`, or a Linux
    /// AppImage (the only Linux format the plugin supports).
    SelfUpdating,
    /// Something else owns this install — a distro package manager, or a binary
    /// unpacked by hand. Writing to it would be wrong even where it's possible,
    /// so the UI offers a download and stops there.
    Managed,
}

/// How the running build was installed.
///
/// macOS only ever ships a `.app` bundle, so it is always self-updating. Linux
/// is split: an AppImage sets `APPIMAGE` to its own path and can be replaced,
/// while a `.deb`/`.rpm` install lives in `/usr/bin` under the package
/// database's ownership and must be left to `apt`/`dnf`.
fn install_method() -> InstallMethod {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            InstallMethod::SelfUpdating
        } else {
            InstallMethod::Managed
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        InstallMethod::SelfUpdating
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub status: UpdateStatus,
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub is_prerelease: bool,
    pub release_notes: String,
    pub release_url: String,
    pub published_at: Option<String>,
    /// Whether the UI may offer a one-click install, or only a download link.
    pub install_method: InstallMethod,
    /// Download URL for the bundle matching the running platform and
    /// architecture, when one can be identified unambiguously.
    pub download_url: Option<String>,
    pub download_size: Option<u64>,
    pub asset_name: Option<String>,
    /// Epoch millis, so the UI can render "last checked" without a second call.
    pub checked_at: u64,
}

/// One cached check per channel, so toggling channels in Settings doesn't serve
/// a stale answer from the other one.
#[derive(Default)]
pub struct UpdaterState {
    stable: Mutex<Option<CacheEntry>>,
    prerelease: Mutex<Option<CacheEntry>>,
}

struct CacheEntry {
    fetched_at: Instant,
    info: UpdateInfo,
}

impl UpdaterState {
    fn slot(&self, channel: Channel) -> &Mutex<Option<CacheEntry>> {
        match channel {
            Channel::Stable => &self.stable,
            Channel::Prerelease => &self.prerelease,
        }
    }

    fn cached(&self, channel: Channel) -> Option<UpdateInfo> {
        let guard = self.slot(channel).lock().ok()?;
        let entry = guard.as_ref()?;
        (entry.fetched_at.elapsed() < CACHE_TTL).then(|| entry.info.clone())
    }

    fn store(&self, channel: Channel, info: UpdateInfo) {
        if let Ok(mut guard) = self.slot(channel).lock() {
            *guard = Some(CacheEntry {
                fetched_at: Instant::now(),
                info,
            });
        }
    }
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// The bundle extension worth offering on this platform, lowercased.
///
/// Linux is AppImage-only on purpose. It is the one Linux format Tauri's updater
/// can install, and the one that runs on any distro without a package manager —
/// a `.deb` or `.rpm` is the package manager's business, not ours, so pointing
/// someone at one from inside the app would be offering an install we can't
/// complete.
#[cfg(target_os = "macos")]
const BUNDLE_EXT: &str = ".dmg";
#[cfg(target_os = "linux")]
const BUNDLE_EXT: &str = ".appimage";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const BUNDLE_EXT: &str = ".msi";

/// Match on the asset-name suffix rather than reconstructing the expected
/// filename, so a bundler naming change degrades to "no direct download link"
/// instead of silently pointing at the wrong architecture.
fn asset_for_current_target(assets: &[GhAsset]) -> Option<&GhAsset> {
    // Bundlers disagree on how to spell an architecture — Tauri's macOS bundle
    // says `aarch64`/`x64`, its Linux one uses Debian's `arm64`/`amd64` — so
    // accept any of the spellings.
    let arch_tokens: &[&str] = if cfg!(target_arch = "aarch64") {
        &["aarch64", "arm64"]
    } else {
        &["x64", "x86_64", "amd64", "intel"]
    };

    let candidates: Vec<&GhAsset> = assets
        .iter()
        .filter(|a| a.name.to_lowercase().ends_with(BUNDLE_EXT))
        .collect();

    if let Some(matched) = candidates
        .iter()
        .find(|a| {
            let name = a.name.to_lowercase();
            arch_tokens
                .iter()
                .any(|token| name.ends_with(&format!("{token}{BUNDLE_EXT}")))
        })
        .copied()
    {
        return Some(matched);
    }

    // A single-architecture release has nothing to disambiguate, so a lone
    // unsuffixed bundle is safe to offer. Two or more without a recognised
    // suffix is not.
    match candidates.as_slice() {
        [only] => Some(only),
        _ => None,
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn fetch_release(current_version: &str, channel: Channel) -> Result<GhRelease, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // GitHub rejects API requests that arrive without a User-Agent.
        .user_agent(format!("FigyTerm/{current_version}"))
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;

    let url = match channel {
        // GitHub's /latest endpoint already excludes prereleases and drafts.
        Channel::Stable => format!("https://api.github.com/repos/{REPO}/releases/latest"),
        Channel::Prerelease => format!("https://api.github.com/repos/{REPO}/releases?per_page=10"),
    };

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Timed out reaching GitHub. Check your connection and try again.".to_string()
            } else if e.is_connect() {
                "Could not reach GitHub. Check your connection and try again.".to_string()
            } else {
                format!("Network error: {e}")
            }
        })?;

    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(
            "GitHub's rate limit was reached. Please try again in a little while.".to_string(),
        );
    }
    if status.as_u16() == 404 {
        return Err("No published releases were found for FigyTerm.".to_string());
    }
    if !status.is_success() {
        return Err(format!("GitHub returned an unexpected response ({status})."));
    }

    match channel {
        Channel::Stable => response
            .json::<GhRelease>()
            .await
            .map_err(|e| format!("Could not read GitHub's response: {e}")),
        Channel::Prerelease => {
            let releases: Vec<GhRelease> = response
                .json()
                .await
                .map_err(|e| format!("Could not read GitHub's response: {e}"))?;
            releases
                .into_iter()
                .find(|r| !r.draft)
                .ok_or_else(|| "No published releases were found for FigyTerm.".to_string())
        }
    }
}

fn build_info(current_raw: &str, release: GhRelease) -> Result<UpdateInfo, String> {
    let latest_raw = release
        .tag_name
        .trim()
        .trim_start_matches('v')
        .trim()
        .to_string();

    let current = Version::parse(current_raw).map_err(|_| {
        format!("Could not read the installed version number ('{current_raw}').")
    })?;
    let latest = Version::parse(&latest_raw).map_err(|_| {
        format!(
            "Could not read the released version number ('{}').",
            release.tag_name
        )
    })?;

    let status = match latest.cmp(&current) {
        Ordering::Greater => UpdateStatus::UpdateAvailable,
        Ordering::Equal => UpdateStatus::UpToDate,
        Ordering::Less => UpdateStatus::DevBuild,
    };

    let asset = asset_for_current_target(&release.assets);

    Ok(UpdateInfo {
        status,
        current_version: current.to_string(),
        latest_version: latest_raw,
        update_available: matches!(status, UpdateStatus::UpdateAvailable),
        is_prerelease: release.prerelease,
        release_notes: release.body.unwrap_or_default(),
        release_url: release.html_url,
        published_at: release.published_at,
        install_method: install_method(),
        download_url: asset.map(|a| a.browser_download_url.clone()),
        download_size: asset.map(|a| a.size),
        asset_name: asset.map(|a| a.name.clone()),
        checked_at: epoch_millis(),
    })
}

#[tauri::command]
pub fn get_current_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Relaunch into the version that was just installed. Diverges — it never
/// returns to the caller.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// Names of commands currently running in any terminal pane.
///
/// Installing an update relaunches the app, which kills every pane. Ending
/// someone's in-flight `terraform apply` to install a point release is not a
/// decision to make on their behalf, so the UI asks first when this is
/// non-empty.
#[tauri::command]
pub fn running_foreground_commands(state: State<'_, crate::state::app_state::AppState>) -> Vec<String> {
    let Ok(manager) = state.terminal_manager.lock() else {
        return Vec::new();
    };
    let Some(mgr) = manager.as_ref() else {
        return Vec::new();
    };

    let pids = mgr.foreground_pids();
    if pids.is_empty() {
        return Vec::new();
    }

    let mut system = sysinfo::System::new();
    let to_refresh: Vec<sysinfo::Pid> = pids.iter().map(|p| sysinfo::Pid::from_u32(*p)).collect();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&to_refresh), true);

    let mut names: Vec<String> = to_refresh
        .iter()
        .filter_map(|pid| system.process(*pid))
        .map(|proc| proc.name().to_string_lossy().to_string())
        .collect();

    names.sort();
    names.dedup();
    names
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    channel: Option<Channel>,
    force: Option<bool>,
) -> Result<UpdateInfo, String> {
    let channel = channel.unwrap_or_default();

    // A manual "Check Now" should never be answered from cache — but the
    // automatic startup check should, so repeated launches don't burn quota.
    if !force.unwrap_or(false) {
        if let Some(hit) = state.cached(channel) {
            return Ok(hit);
        }
    }

    let current = app.package_info().version.to_string();
    let release = fetch_release(&current, channel).await?;
    let info = build_info(&current, release)?;
    state.store(channel, info.clone());
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.test/{name}"),
            size: 1,
        }
    }

    fn release(tag: &str, assets: Vec<GhAsset>) -> GhRelease {
        GhRelease {
            tag_name: tag.to_string(),
            html_url: "https://example.test/release".to_string(),
            body: None,
            published_at: None,
            prerelease: false,
            draft: false,
            assets,
        }
    }

    #[test]
    fn newer_release_is_an_update() {
        let info = build_info("0.0.6", release("v0.0.7", vec![])).unwrap();
        assert!(info.update_available);
        assert!(matches!(info.status, UpdateStatus::UpdateAvailable));
        assert_eq!(info.latest_version, "0.0.7");
    }

    #[test]
    fn equal_release_is_up_to_date() {
        let info = build_info("0.0.6", release("v0.0.6", vec![])).unwrap();
        assert!(!info.update_available);
        assert!(matches!(info.status, UpdateStatus::UpToDate));
    }

    #[test]
    fn local_version_ahead_is_a_dev_build_not_an_error() {
        // The committed version (0.1.0) is currently ahead of the latest tag (v0.0.6).
        let info = build_info("0.1.0", release("v0.0.6", vec![])).unwrap();
        assert!(!info.update_available);
        assert!(matches!(info.status, UpdateStatus::DevBuild));
    }

    #[test]
    fn unparseable_versions_surface_as_errors() {
        assert!(build_info("0.0.6", release("nightly", vec![])).is_err());
        assert!(build_info("not-a-version", release("v0.0.7", vec![])).is_err());
    }

    /// Mixed case on purpose — the Linux bundler really does emit `.AppImage`,
    /// and matching must not depend on the casing.
    ///
    /// Windows is not a shipping target; adding one means revisiting
    /// `asset_for_current_target` (its `.msi` names carry a locale suffix) along
    /// with these helpers.
    fn bundle_ext() -> &'static str {
        if cfg!(target_os = "linux") {
            "AppImage"
        } else {
            "dmg"
        }
    }

    /// The architecture token this platform's bundler uses: Tauri writes
    /// `aarch64`/`x64` for macOS and Debian's `arm64`/`amd64` for Linux.
    fn arch_tokens() -> (&'static str, &'static str) {
        if cfg!(target_os = "linux") {
            ("arm64", "amd64")
        } else {
            ("aarch64", "x64")
        }
    }

    /// Both architectures for this platform, as a release carries them.
    fn platform_assets(version: &str) -> Vec<GhAsset> {
        let (arm, intel) = arch_tokens();
        let ext = bundle_ext();
        vec![
            asset(&format!("FigyTerm_{version}_{arm}.{ext}")),
            asset(&format!("FigyTerm_{version}_{intel}.{ext}")),
        ]
    }

    /// The one of those the running build should select.
    fn expected_asset(version: &str) -> String {
        let (arm, intel) = arch_tokens();
        let arch = if cfg!(target_arch = "aarch64") {
            arm
        } else {
            intel
        };
        format!("FigyTerm_{version}_{arch}.{}", bundle_ext())
    }

    #[test]
    fn picks_the_bundle_for_this_platform_and_architecture() {
        let assets = platform_assets("0.0.7");
        let picked = asset_for_current_target(&assets).expect("an asset should match");
        assert_eq!(picked.name, expected_asset("0.0.7"));
    }

    #[test]
    fn a_lone_unsuffixed_bundle_is_offered_but_an_ambiguous_pair_is_not() {
        let ext = bundle_ext();

        let single = vec![asset(&format!("FigyTerm.{ext}"))];
        assert!(asset_for_current_target(&single).is_some());

        let ambiguous = vec![
            asset(&format!("FigyTerm-one.{ext}")),
            asset(&format!("FigyTerm-two.{ext}")),
        ];
        assert!(asset_for_current_target(&ambiguous).is_none());
    }

    /// Guards the deserialisation against GitHub payload drift, using the field
    /// shape of the v0.0.6 release plus the Linux artifacts a release carries
    /// once the Linux job is in the pipeline.
    #[test]
    fn parses_a_real_github_release_payload() {
        // r###"…"### because the release body itself opens with `"##`.
        let payload = r###"{
            "tag_name": "v0.0.6",
            "html_url": "https://github.com/code4mk/figyterm/releases/tag/v0.0.6",
            "body": "## FigyTerm v0.0.6\n\n### What's New\nStuff.",
            "published_at": "2026-09-03T06:53:20Z",
            "prerelease": false,
            "draft": false,
            "assets": [
                {"name": "FigyTerm_0.0.6_aarch64.app.tar.gz", "browser_download_url": "https://example.test/a", "size": 7346876},
                {"name": "FigyTerm_0.0.6_aarch64.dmg", "browser_download_url": "https://example.test/b", "size": 8068596},
                {"name": "FigyTerm_0.0.6_x64.app.tar.gz", "browser_download_url": "https://example.test/c", "size": 7441989},
                {"name": "FigyTerm_0.0.6_x64.dmg", "browser_download_url": "https://example.test/d", "size": 8156110},
                {"name": "FigyTerm_0.0.6_amd64.AppImage", "browser_download_url": "https://example.test/e", "size": 9231044},
                {"name": "FigyTerm_0.0.6_arm64.AppImage", "browser_download_url": "https://example.test/f", "size": 9014377},
                {"name": "FigyTerm_0.0.6_amd64.deb", "browser_download_url": "https://example.test/g", "size": 6720418},
                {"name": "FigyTerm-0.0.6-1.x86_64.rpm", "browser_download_url": "https://example.test/h", "size": 6733901}
            ]
        }"###;

        let release: GhRelease = serde_json::from_str(payload).expect("payload should parse");
        let info = build_info("0.0.5", release).unwrap();

        assert!(info.update_available);
        assert_eq!(info.latest_version, "0.0.6");
        assert_eq!(info.published_at.as_deref(), Some("2026-09-03T06:53:20Z"));

        // Neither the .app.tar.gz updater payloads nor the distro packages are
        // ever offered as the download.
        let expected = expected_asset("0.0.6");
        assert_eq!(info.asset_name.as_deref(), Some(expected.as_str()));

        // The size must come from the matching entry, not from the first asset.
        let expected_size = match expected.as_str() {
            "FigyTerm_0.0.6_aarch64.dmg" => 8068596,
            "FigyTerm_0.0.6_x64.dmg" => 8156110,
            "FigyTerm_0.0.6_arm64.AppImage" => 9014377,
            "FigyTerm_0.0.6_amd64.AppImage" => 9231044,
            other => panic!("no size fixture for {other}"),
        };
        assert_eq!(info.download_size, Some(expected_size));
    }

    #[test]
    fn other_platforms_and_side_artifacts_are_ignored() {
        // `.app.tar.gz` is the updater plugin's own payload, and `.deb`/`.rpm`
        // belong to a package manager. Offering either as a download would be
        // offering an install the app can't complete.
        let assets = vec![
            asset("FigyTerm_0.0.7.app.tar.gz"),
            asset("FigyTerm_0.0.7_amd64.deb"),
            asset("FigyTerm-0.0.7-1.x86_64.rpm"),
            asset("checksums.txt"),
        ];
        assert!(asset_for_current_target(&assets).is_none());
    }

    #[test]
    fn a_package_managed_install_never_claims_to_self_update() {
        // On macOS every install is a .app bundle the updater can replace. On
        // Linux only an AppImage can be, and `APPIMAGE` is how one identifies
        // itself — the test asserts the invariant the UI depends on rather than
        // mutating process-global env.
        let method = install_method();
        if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
            assert_eq!(method, InstallMethod::Managed);
        } else {
            assert_eq!(method, InstallMethod::SelfUpdating);
        }
    }
}

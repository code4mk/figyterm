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
    /// Download URL for the `.dmg` matching the running architecture, when one
    /// can be identified unambiguously.
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

/// Match on the asset-name suffix rather than reconstructing the expected
/// filename, so a bundler naming change degrades to "no direct download link"
/// instead of silently pointing at the wrong architecture.
fn asset_for_current_arch(assets: &[GhAsset]) -> Option<&GhAsset> {
    let suffixes: &[&str] = if cfg!(target_arch = "aarch64") {
        &["aarch64.dmg", "arm64.dmg"]
    } else {
        &["x64.dmg", "x86_64.dmg", "intel.dmg"]
    };

    let dmgs: Vec<&GhAsset> = assets
        .iter()
        .filter(|a| a.name.to_lowercase().ends_with(".dmg"))
        .collect();

    if let Some(matched) = dmgs
        .iter()
        .find(|a| {
            let name = a.name.to_lowercase();
            suffixes.iter().any(|s| name.ends_with(s))
        })
        .copied()
    {
        return Some(matched);
    }

    // A single-architecture release has nothing to disambiguate, so an unsuffixed
    // lone .dmg is safe to offer. Two or more without a recognised suffix is not.
    match dmgs.as_slice() {
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

    let asset = asset_for_current_arch(&release.assets);

    Ok(UpdateInfo {
        status,
        current_version: current.to_string(),
        latest_version: latest_raw,
        update_available: matches!(status, UpdateStatus::UpdateAvailable),
        is_prerelease: release.prerelease,
        release_notes: release.body.unwrap_or_default(),
        release_url: release.html_url,
        published_at: release.published_at,
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

    #[test]
    fn picks_the_dmg_for_this_architecture() {
        let assets = vec![
            asset("FigyTerm_0.0.7_aarch64.dmg"),
            asset("FigyTerm_0.0.7_x64.dmg"),
        ];
        let picked = asset_for_current_arch(&assets).expect("an asset should match");
        if cfg!(target_arch = "aarch64") {
            assert_eq!(picked.name, "FigyTerm_0.0.7_aarch64.dmg");
        } else {
            assert_eq!(picked.name, "FigyTerm_0.0.7_x64.dmg");
        }
    }

    #[test]
    fn a_lone_unsuffixed_dmg_is_offered_but_an_ambiguous_pair_is_not() {
        let single = vec![asset("FigyTerm.dmg")];
        assert!(asset_for_current_arch(&single).is_some());

        let ambiguous = vec![asset("FigyTerm-one.dmg"), asset("FigyTerm-two.dmg")];
        assert!(asset_for_current_arch(&ambiguous).is_none());
    }

    /// Guards the deserialisation against GitHub payload drift, using the real
    /// asset names and field shape from the v0.0.6 release.
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
                {"name": "FigyTerm_0.0.6_x64.dmg", "browser_download_url": "https://example.test/d", "size": 8156110}
            ]
        }"###;

        let release: GhRelease = serde_json::from_str(payload).expect("payload should parse");
        let info = build_info("0.0.5", release).unwrap();

        assert!(info.update_available);
        assert_eq!(info.latest_version, "0.0.6");
        assert_eq!(info.published_at.as_deref(), Some("2026-09-03T06:53:20Z"));

        // The .app.tar.gz artifacts must never be offered as the download.
        let asset = info.asset_name.expect("a dmg should be selected");
        assert!(asset.ends_with(".dmg"), "picked {asset}");
        if cfg!(target_arch = "aarch64") {
            assert_eq!(asset, "FigyTerm_0.0.6_aarch64.dmg");
            assert_eq!(info.download_size, Some(8068596));
        } else {
            assert_eq!(asset, "FigyTerm_0.0.6_x64.dmg");
            assert_eq!(info.download_size, Some(8156110));
        }
    }

    #[test]
    fn non_dmg_assets_are_ignored() {
        let assets = vec![asset("FigyTerm_0.0.7.app.tar.gz"), asset("checksums.txt")];
        assert!(asset_for_current_arch(&assets).is_none());
    }
}

use crate::local_path::LocalPathPolicy;
use crate::native_io::NativeIo;
use crate::recent::{RecentDocument, RecentListOutcome, RecentStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

const MAX_RECENT_ALIAS_ENTRIES: usize = 15;
const MAX_PROVIDER_UTF16_UNITS: usize = 32_768;
const MAX_PROVIDER_TEXT_UNITS: usize = MAX_PROVIDER_UTF16_UNITS - 1;
const MAX_DRIVE_LETTERS: usize = 26;
const DRIVE_REMOTE: u32 = 4;

static ALIAS_LOOKUP_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
struct AliasLookupLease;
impl AliasLookupLease {
    fn acquire() -> Option<Self> {
        ALIAS_LOOKUP_ACTIVE
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .ok()
            .map(|_| Self)
    }
}
impl Drop for AliasLookupLease {
    fn drop(&mut self) {
        ALIAS_LOOKUP_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDisplayAlias {
    recent_id: String,
    display_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "tag",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum RecentDisplayAliasesOutcome {
    Ready {
        revision: String,
        aliases: Vec<RecentDisplayAlias>,
    },
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RecentAliasCandidate {
    recent_id: String,
    display_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DriveMapping {
    drive: char,
    unc_root: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LookupFailure {
    Provider,
    InvalidMapping,
}

trait DriveMappingProvider {
    fn mappings(&self) -> Result<Vec<DriveMapping>, LookupFailure>;
}

/// Lists aliases for the bounded native recent snapshot. The renderer supplies no path: all
/// candidate paths come from the native RecentStore snapshot and all mapping queries happen in
/// the worker after the recent-store mutex has been released.
#[tauri::command]
pub async fn list_recent_display_aliases(window: tauri::Window) -> RecentDisplayAliasesOutcome {
    let Some(recents) = window.try_state::<Mutex<RecentStore>>() else {
        return RecentDisplayAliasesOutcome::Unavailable;
    };
    let snapshot = {
        let Ok(store) = recents.lock() else {
            return RecentDisplayAliasesOutcome::Unavailable;
        };
        store.list_outcome()
    };
    let RecentListOutcome::Ready { revision, entries } = snapshot else {
        return RecentDisplayAliasesOutcome::Unavailable;
    };
    let candidates = entries
        .into_iter()
        .take(MAX_RECENT_ALIAS_ENTRIES)
        .map(candidate_from_document)
        .collect::<Vec<_>>();
    if candidates.is_empty()
        || !candidates
            .iter()
            .any(|candidate| is_unc_path(&candidate.display_path))
    {
        return RecentDisplayAliasesOutcome::Ready {
            revision,
            aliases: Vec::new(),
        };
    }
    let Some(lookup) = AliasLookupLease::acquire() else {
        return RecentDisplayAliasesOutcome::Unavailable;
    };
    let Ok(permit) = NativeIo::global().control.try_acquire() else {
        return RecentDisplayAliasesOutcome::Unavailable;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _lookup = lookup;
        let _permit = permit;
        let provider = WindowsDriveMappingProvider;
        outcome_for_candidates(revision, &candidates, &provider)
    })
    .await
    .unwrap_or(RecentDisplayAliasesOutcome::Unavailable)
}

fn outcome_for_candidates<P: DriveMappingProvider>(
    revision: String,
    candidates: &[RecentAliasCandidate],
    provider: &P,
) -> RecentDisplayAliasesOutcome {
    match aliases_for_candidates(candidates, provider) {
        Ok(aliases) => RecentDisplayAliasesOutcome::Ready { revision, aliases },
        Err(_) => RecentDisplayAliasesOutcome::Unavailable,
    }
}

fn candidate_from_document(document: RecentDocument) -> RecentAliasCandidate {
    RecentAliasCandidate {
        recent_id: document.recent_id().to_owned(),
        display_path: document.display_path().to_owned(),
    }
}

fn aliases_for_candidates<P: DriveMappingProvider>(
    candidates: &[RecentAliasCandidate],
    provider: &P,
) -> Result<Vec<RecentDisplayAlias>, LookupFailure> {
    if candidates.len() > MAX_RECENT_ALIAS_ENTRIES {
        return Err(LookupFailure::InvalidMapping);
    }
    if candidates
        .iter()
        .any(|candidate| candidate.display_path.encode_utf16().count() > MAX_PROVIDER_TEXT_UNITS)
    {
        return Err(LookupFailure::InvalidMapping);
    }
    if candidates.is_empty()
        || !candidates
            .iter()
            .any(|candidate| is_unc_path(&candidate.display_path))
    {
        return Ok(Vec::new());
    }
    let mappings = provider.mappings()?;
    let mappings = normalize_mappings(mappings)?;
    Ok(candidates
        .iter()
        .filter_map(|candidate| alias_for_candidate(candidate, &mappings))
        .collect())
}

fn normalize_mappings(mappings: Vec<DriveMapping>) -> Result<Vec<DriveMapping>, LookupFailure> {
    if mappings.len() > MAX_DRIVE_LETTERS {
        return Err(LookupFailure::InvalidMapping);
    }
    let mut normalized = Vec::with_capacity(mappings.len());
    for mapping in mappings {
        let drive = normalize_drive_letter(mapping.drive).ok_or(LookupFailure::InvalidMapping)?;
        let unc_root =
            normalize_unc_root(&mapping.unc_root).ok_or(LookupFailure::InvalidMapping)?;
        if normalized
            .iter()
            .any(|existing: &DriveMapping| existing.drive == drive)
        {
            return Err(LookupFailure::InvalidMapping);
        }
        normalized.push(DriveMapping { drive, unc_root });
    }
    Ok(normalized)
}

fn normalize_drive_letter(drive: char) -> Option<char> {
    drive
        .is_ascii_alphabetic()
        .then(|| drive.to_ascii_uppercase())
}

fn normalize_unc_root(value: &str) -> Option<String> {
    let root = value.trim_end_matches(['\\', '/']);
    if !is_unc_path(root) || root.encode_utf16().count() > MAX_PROVIDER_TEXT_UNITS {
        return None;
    }
    crate::local_path::SystemLocalPathPolicy
        .validate_syntax(std::path::Path::new(root))
        .ok()?;
    let components = root[2..].split(['\\', '/']).collect::<Vec<_>>();
    if components.len() < 2 || components.iter().any(|component| component.is_empty()) {
        return None;
    }
    Some(root.to_owned())
}

fn alias_for_candidate(
    candidate: &RecentAliasCandidate,
    mappings: &[DriveMapping],
) -> Option<RecentDisplayAlias> {
    let mut best: Option<(&DriveMapping, usize, usize)> = None;
    for mapping in mappings {
        let Some(prefix_end) = matching_prefix_end(&candidate.display_path, &mapping.unc_root)
        else {
            continue;
        };
        let root_length = mapping.unc_root.encode_utf16().count();
        let should_replace = best.map_or(true, |(current, current_length, _)| {
            root_length > current_length
                || (root_length == current_length && mapping.drive < current.drive)
        });
        if should_replace {
            best = Some((mapping, root_length, prefix_end));
        }
    }
    let (mapping, _, prefix_end) = best?;
    let suffix = &candidate.display_path[prefix_end..];
    let display_path = alias_path(mapping.drive, suffix);
    if display_path.encode_utf16().count() > MAX_PROVIDER_TEXT_UNITS {
        return None;
    }
    Some(RecentDisplayAlias {
        recent_id: candidate.recent_id.clone(),
        display_path,
    })
}

fn alias_path(drive: char, suffix: &str) -> String {
    let mut path = String::with_capacity(3 + suffix.len());
    path.push(drive);
    path.push(':');
    if suffix.is_empty() {
        path.push('\\');
    } else if suffix.starts_with('\\') || suffix.starts_with('/') {
        path.push_str(suffix);
    } else {
        path.push('\\');
        path.push_str(suffix);
    }
    path
}

fn is_unc_path(path: &str) -> bool {
    path.starts_with(r"\\")
}

fn matching_prefix_end(path: &str, root: &str) -> Option<usize> {
    if !is_unc_path(path) {
        return None;
    }
    let root_units = root.encode_utf16().count();
    let prefix_end = utf16_prefix_end(path, root_units)?;
    if !windows_ordinal_equal(&path[..prefix_end], root) {
        return None;
    }
    match path[prefix_end..].chars().next() {
        None | Some('\\') | Some('/') => Some(prefix_end),
        Some(_) => None,
    }
}

fn utf16_prefix_end(value: &str, units: usize) -> Option<usize> {
    let mut count = 0;
    for (index, character) in value.char_indices() {
        if count == units {
            return Some(index);
        }
        count += character.len_utf16();
        if count > units {
            return None;
        }
    }
    (count == units).then_some(value.len())
}

fn windows_ordinal_equal(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
        let left = left.encode_utf16().collect::<Vec<_>>();
        let right = right.encode_utf16().collect::<Vec<_>>();
        unsafe { CompareStringOrdinal(&left, &right, true) == CSTR_EQUAL }
    }
    #[cfg(not(windows))]
    {
        left.eq_ignore_ascii_case(right)
    }
}

struct WindowsDriveMappingProvider;

#[cfg(windows)]
impl DriveMappingProvider for WindowsDriveMappingProvider {
    fn mappings(&self) -> Result<Vec<DriveMapping>, LookupFailure> {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{
            ERROR_BAD_DEVICE, ERROR_BAD_NETPATH, ERROR_BAD_NET_NAME, ERROR_CONNECTION_UNAVAIL,
            ERROR_NOT_CONNECTED, ERROR_NO_NETWORK, ERROR_NO_NET_OR_BAD_PATH,
        };
        use windows::Win32::NetworkManagement::WNet::WNetGetConnectionW;
        use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

        let logical_drives = unsafe { GetLogicalDrives() };
        if logical_drives == 0 {
            return Err(LookupFailure::Provider);
        }
        let mut mappings = Vec::new();
        for index in 0..MAX_DRIVE_LETTERS {
            if logical_drives & (1_u32 << index) == 0 {
                continue;
            }
            let drive = (b'A' + index as u8) as char;
            let root = [drive as u16, b':' as u16, b'\\' as u16, 0];
            if unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } != DRIVE_REMOTE {
                continue;
            }
            let local = [drive as u16, b':' as u16, 0];
            let mut remote = vec![0_u16; MAX_PROVIDER_UTF16_UNITS];
            let mut length = remote.len() as u32;
            let result = unsafe {
                WNetGetConnectionW(
                    PCWSTR(local.as_ptr()),
                    Some(PWSTR(remote.as_mut_ptr())),
                    &mut length,
                )
            };
            if result == windows::Win32::Foundation::WIN32_ERROR(0) {
                let Some(end) = remote.iter().position(|character| *character == 0) else {
                    return Err(LookupFailure::Provider);
                };
                if end > MAX_PROVIDER_TEXT_UNITS {
                    return Err(LookupFailure::Provider);
                }
                let remote =
                    String::from_utf16(&remote[..end]).map_err(|_| LookupFailure::Provider)?;
                let Some(unc_root) = normalize_unc_root(&remote) else {
                    return Err(LookupFailure::Provider);
                };
                mappings.push(DriveMapping { drive, unc_root });
            } else if matches!(
                result,
                ERROR_BAD_DEVICE
                    | ERROR_BAD_NET_NAME
                    | ERROR_BAD_NETPATH
                    | ERROR_CONNECTION_UNAVAIL
                    | ERROR_NO_NETWORK
                    | ERROR_NO_NET_OR_BAD_PATH
                    | ERROR_NOT_CONNECTED
            ) {
                continue;
            } else {
                return Err(LookupFailure::Provider);
            }
        }
        Ok(mappings)
    }
}

#[cfg(not(windows))]
impl DriveMappingProvider for WindowsDriveMappingProvider {
    fn mappings(&self) -> Result<Vec<DriveMapping>, LookupFailure> {
        Err(LookupFailure::Provider)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct StubProvider {
        result: Result<Vec<DriveMapping>, LookupFailure>,
    }

    impl DriveMappingProvider for StubProvider {
        fn mappings(&self) -> Result<Vec<DriveMapping>, LookupFailure> {
            self.result.clone()
        }
    }

    fn candidate(recent_id: &str, display_path: &str) -> RecentAliasCandidate {
        RecentAliasCandidate {
            recent_id: recent_id.to_owned(),
            display_path: display_path.to_owned(),
        }
    }

    fn mapping(drive: char, unc_root: &str) -> DriveMapping {
        DriveMapping {
            drive,
            unc_root: unc_root.to_owned(),
        }
    }

    #[test]
    fn z_and_v_aliases_preserve_recent_order() {
        let candidates = [
            candidate("recent-z", r"\\server\share\zeta\one.pdf"),
            candidate("recent-v", r"\\server\other\資料\two.pdf"),
        ];
        let provider = StubProvider {
            result: Ok(vec![
                mapping('Z', r"\\server\share"),
                mapping('V', r"\\server\other"),
            ]),
        };
        let aliases = aliases_for_candidates(&candidates, &provider).unwrap();
        assert_eq!(
            aliases,
            vec![
                RecentDisplayAlias {
                    recent_id: "recent-z".into(),
                    display_path: r"Z:\zeta\one.pdf".into(),
                },
                RecentDisplayAlias {
                    recent_id: "recent-v".into(),
                    display_path: r"V:\資料\two.pdf".into(),
                },
            ]
        );
    }

    #[test]
    fn matching_is_case_insensitive_with_component_boundaries() {
        let candidates = [
            candidate("match", r"\\SERVER\Share\folder\file.pdf"),
            candidate("lookalike", r"\\server\share-other\file.pdf"),
        ];
        let provider = StubProvider {
            result: Ok(vec![mapping('Z', r"\\server\share")]),
        };
        let aliases = aliases_for_candidates(&candidates, &provider).unwrap();
        assert_eq!(
            aliases,
            vec![RecentDisplayAlias {
                recent_id: "match".into(),
                display_path: r"Z:\folder\file.pdf".into(),
            }]
        );
    }

    #[test]
    fn longest_mapping_root_wins() {
        let candidates = [candidate("nested", r"\\server\share\team\file.pdf")];
        let provider = StubProvider {
            result: Ok(vec![
                mapping('Z', r"\\server\share"),
                mapping('V', r"\\server\share\team"),
            ]),
        };
        let aliases = aliases_for_candidates(&candidates, &provider).unwrap();
        assert_eq!(aliases[0].display_path, r"V:\file.pdf");
    }

    #[test]
    fn equal_roots_use_lexical_drive_tie_break() {
        let candidates = [candidate("same", r"\\server\share\file.pdf")];
        let provider = StubProvider {
            result: Ok(vec![
                mapping('Z', r"\\server\share"),
                mapping('V', r"\\SERVER\SHARE"),
            ]),
        };
        let aliases = aliases_for_candidates(&candidates, &provider).unwrap();
        assert_eq!(aliases[0].display_path, r"V:\file.pdf");
    }

    #[test]
    fn local_and_unmapped_paths_are_not_projected() {
        let candidates = [
            candidate("local", r"C:\docs\local.pdf"),
            candidate("unmapped", r"\\other\share\file.pdf"),
        ];
        let provider = StubProvider {
            result: Ok(vec![mapping('Z', r"\\server\share")]),
        };
        assert!(aliases_for_candidates(&candidates, &provider)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn provider_failure_is_bounded_to_unavailable() {
        let candidates = [candidate("recent", r"\\server\share\file.pdf")];
        let provider = StubProvider {
            result: Err(LookupFailure::Provider),
        };
        assert_eq!(
            outcome_for_candidates("revision".into(), &candidates, &provider),
            RecentDisplayAliasesOutcome::Unavailable
        );
    }

    #[test]
    fn mapping_roots_are_not_exposed_in_the_dto() {
        let candidates = [candidate("recent", r"\\server\share\file.pdf")];
        let provider = StubProvider {
            result: Ok(vec![mapping('Z', r"\\server\share")]),
        };
        let aliases = aliases_for_candidates(&candidates, &provider).unwrap();
        let output = RecentDisplayAliasesOutcome::Ready {
            revision: "7".into(),
            aliases,
        };
        let json = serde_json::to_value(output).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "tag": "READY",
                "revision": "7",
                "aliases": [{"recentId": "recent", "displayPath": r"Z:\file.pdf"}]
            })
        );
    }
    #[test]
    fn rejects_oversized_or_ambiguous_provider_data() {
        let candidates = (0..16)
            .map(|index| candidate(&format!("recent-{index}"), r"\\server\share\file.pdf"))
            .collect::<Vec<_>>();
        let empty = StubProvider {
            result: Ok(Vec::new()),
        };
        assert_eq!(
            aliases_for_candidates(&candidates, &empty),
            Err(LookupFailure::InvalidMapping)
        );
        let duplicate = StubProvider {
            result: Ok(vec![
                mapping('V', r"\\server\share"),
                mapping('v', r"\\other\share"),
            ]),
        };
        assert_eq!(
            aliases_for_candidates(&candidates[..1], &duplicate),
            Err(LookupFailure::InvalidMapping)
        );
        assert!(normalize_unc_root(r"\\?\UNC\server\share").is_none());
        assert!(normalize_unc_root(r"\\server\IPC$").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn matches_unicode_roots_with_windows_ordinal_comparison() {
        let candidates = [candidate("unicode", r"\\SERVER\ΣHARE\자료😀.pdf")];
        let provider = StubProvider {
            result: Ok(vec![mapping('V', r"\\server\σhare")]),
        };
        let aliases = aliases_for_candidates(&candidates, &provider).unwrap();
        assert_eq!(aliases[0].display_path, r"V:\자료😀.pdf");
    }
    #[test]
    fn optional_lookup_has_one_slot_until_the_worker_lease_is_dropped() {
        let lease = AliasLookupLease::acquire().unwrap();
        assert!(AliasLookupLease::acquire().is_none());
        drop(lease);
        assert!(AliasLookupLease::acquire().is_some());
    }
}

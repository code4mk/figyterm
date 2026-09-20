//! Which side wins, row by row.
//!
//! The entire conflict policy is one function, so that it can be read in one
//! sitting and tested exhaustively. Everything else in this module is plumbing
//! around it.
//!
//! The rules, in the order they apply:
//!
//! 1. **A row we have never seen is taken.** There is nothing to weigh it
//!    against.
//! 2. **A row we have not touched is taken.** The remote is the truth for
//!    anything this machine has not edited since the last pass; taking it is
//!    what makes a second machine see the first one's work.
//! 3. **A deletion never becomes a conflicted copy.** Where either side is a
//!    tombstone, the newer timestamp simply wins. A conflicted copy of a row
//!    somebody deliberately deleted is litter, and restoring it silently is
//!    worse than either outcome.
//! 4. **Both sides changed, and theirs is newer: conflict.** The remote keeps
//!    the identity — every other machine already agrees on it — and our version
//!    is kept beside it rather than thrown away.
//! 5. **Both sides changed, and ours is newer or the same: keep ours.** It is
//!    still queued, so the next push sends it.
//!
//! Note what rule 5 is *not*: it is not a merge. Two people editing the same
//! request in the same minute produce one winner and one conflicted copy, and
//! that is the deal last-writer-wins makes. The alternative — merging field by
//! field — buys nothing for a document one person owns, and costs a library, a
//! storage format and a much harder debugging story. See `docs/API-CLIENT.md`.

use serde::Serialize;

/// What the local database knows about a row the remote has sent.
#[derive(Debug, Clone, Copy)]
pub struct LocalState {
    pub updated_at: i64,
    /// Whether it is queued — edited here since the last successful push.
    pub dirty: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct RemoteState {
    pub updated_at: i64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    /// Overwrite the local row with the remote one.
    TakeRemote,
    /// Leave the local row alone; it is queued and will be pushed.
    KeepLocal,
    /// Take the remote row *and* keep ours beside it, marked.
    Conflict,
}

pub fn decide(local: Option<LocalState>, remote: RemoteState) -> Decision {
    let Some(local) = local else {
        return Decision::TakeRemote;
    };

    if !local.dirty {
        return Decision::TakeRemote;
    }

    if local.deleted || remote.deleted {
        return if remote.updated_at > local.updated_at {
            Decision::TakeRemote
        } else {
            Decision::KeepLocal
        };
    }

    if remote.updated_at > local.updated_at {
        Decision::Conflict
    } else {
        Decision::KeepLocal
    }
}

/// The name a conflicted copy takes.
///
/// It names the machine and the day, because the question somebody asks when
/// they find one is "which of these is mine?" — and the answer is almost always
/// "the one from my laptop".
pub fn conflicted_name(name: &str, device: &str, at: i64) -> String {
    let short: String = device.chars().take(8).collect();
    let day = day_of(at);
    format!("{name} (conflicted copy · {short} · {day})")
}

/// `2026-01-20`, from milliseconds since the epoch, without pulling in a date
/// library for one line.
fn day_of(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    // Civil-from-days, Howard Hinnant's algorithm: exact, no leap-year table.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(updated_at: i64, dirty: bool) -> Option<LocalState> {
        Some(LocalState {
            updated_at,
            dirty,
            deleted: false,
        })
    }

    fn remote(updated_at: i64) -> RemoteState {
        RemoteState {
            updated_at,
            deleted: false,
        }
    }

    #[test]
    fn a_row_we_have_never_seen_is_taken() {
        assert_eq!(decide(None, remote(100)), Decision::TakeRemote);
    }

    /// The rule that makes a second machine see the first one's work.
    #[test]
    fn a_row_we_have_not_touched_is_taken_however_old_it_is() {
        assert_eq!(decide(local(999, false), remote(1)), Decision::TakeRemote);
    }

    #[test]
    fn both_changed_and_theirs_is_newer_is_a_conflict() {
        assert_eq!(decide(local(100, true), remote(200)), Decision::Conflict);
    }

    #[test]
    fn both_changed_and_ours_is_newer_keeps_ours_to_push() {
        assert_eq!(decide(local(200, true), remote(100)), Decision::KeepLocal);
    }

    /// The same timestamp is not a reason to duplicate a row: ours is queued
    /// and the push is idempotent, so keeping it settles the matter.
    #[test]
    fn the_same_timestamp_keeps_ours() {
        assert_eq!(decide(local(100, true), remote(100)), Decision::KeepLocal);
    }

    /// A conflicted copy of something somebody deleted is litter.
    #[test]
    fn a_deletion_never_becomes_a_conflicted_copy() {
        let deleted_here = Some(LocalState {
            updated_at: 100,
            dirty: true,
            deleted: true,
        });
        assert_eq!(decide(deleted_here, remote(200)), Decision::TakeRemote);
        assert_eq!(decide(deleted_here, remote(50)), Decision::KeepLocal);

        let deleted_there = RemoteState {
            updated_at: 200,
            deleted: true,
        };
        assert_eq!(
            decide(local(100, true), deleted_there),
            Decision::TakeRemote
        );
        assert_eq!(decide(local(300, true), deleted_there), Decision::KeepLocal);
    }

    /// A deletion the remote already knows about is not a conflict either: the
    /// row is not dirty, so it is simply taken.
    #[test]
    fn a_settled_deletion_is_just_taken() {
        let deleted = Some(LocalState {
            updated_at: 100,
            dirty: false,
            deleted: true,
        });
        assert_eq!(
            decide(
                deleted,
                RemoteState {
                    updated_at: 100,
                    deleted: true
                }
            ),
            Decision::TakeRemote
        );
    }

    #[test]
    fn a_conflicted_copy_says_whose_and_when() {
        let name = conflicted_name(
            "List users",
            "8f0c2b1a-0000-4000-8000-1234",
            1_768_910_400_000,
        );
        assert_eq!(name, "List users (conflicted copy · 8f0c2b1a · 2026-01-20)");
    }

    #[test]
    fn the_date_arithmetic_holds_at_the_awkward_places() {
        // Epoch, a leap day, and the turn of a century that is not a leap year.
        assert_eq!(day_of(0), "1970-01-01");
        assert_eq!(day_of(951_782_400_000), "2000-02-29");
        assert_eq!(day_of(1_709_164_800_000), "2024-02-29");
        assert_eq!(day_of(1_735_689_600_000), "2025-01-01");
    }
}

//! Where a project's credentials live.
//!
//! The OS keychain — Keychain on macOS, the Credential Manager on Windows, the
//! Secret Service on Linux — and nowhere else. A project key written into
//! `figyman.db` would be one careless backup, one screen share or one support
//! ticket away from being somebody else's, and a settings file is worse.
//!
//! **There is no fallback to a file.** A machine whose keychain will not open
//! cannot sync, and says so. Quietly writing the key somewhere readable instead
//! would be exactly the trade this module exists to refuse.
//!
//! What is *not* here yet: the value of a variable marked secret. Those stay in
//! SQLite and are simply never pushed — the row travels with an empty value. It
//! is half of what `docs/API-CLIENT.md` promises, and the half that matters for
//! sync; the other half is noted there as outstanding.

use keyring::Entry;

const SERVICE: &str = "com.figyterm.figyman";

/// What a credential is called in the keychain.
#[derive(Clone, Copy)]
pub enum Credential {
    /// The project's publishable or service key.
    Key,
    /// The refresh token from a sign-in, which is what keeps a sync running
    /// past the hour the access token lasts.
    Refresh,
}

impl Credential {
    fn name(self, account: &str) -> String {
        match self {
            Credential::Key => format!("{account}:key"),
            Credential::Refresh => format!("{account}:refresh"),
        }
    }
}

fn entry(credential: Credential, account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &credential.name(account)).map_err(|error| {
        format!("This machine's keychain would not open, so credentials cannot be stored: {error}")
    })
}

/// `account` is the project URL: one machine may sync more than one project,
/// and the credentials must not be able to be confused for each other.
pub fn store(credential: Credential, account: &str, secret: &str) -> Result<(), String> {
    entry(credential, account)?
        .set_password(secret)
        .map_err(|error| format!("The keychain refused to store it: {error}"))
}

/// `None` when there is nothing stored, which is not an error — it is what a
/// project that has never been connected looks like.
pub fn read(credential: Credential, account: &str) -> Result<Option<String>, String> {
    match entry(credential, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("The keychain would not give it back: {error}")),
    }
}

/// Forgetting a project. A credential that is already gone is not a failure.
pub fn forget(credential: Credential, account: &str) -> Result<(), String> {
    match entry(credential, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("The keychain would not forget it: {error}")),
    }
}

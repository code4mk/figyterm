//! Postgres over the wire, for a database this app talks to itself.
//!
//! The self-hosted half of the pair. Where the hosted mode goes through
//! somebody's REST layer and inherited its row-level security, this one connects
//! to the database and is therefore trusted with everything in it — which is
//! the trade, and why it is the second mode rather than the first.
//!
//! **Postgres does the JSON.** `to_jsonb(row)` on the way out and
//! `jsonb_populate_recordset` on the way in, so a row crosses in exactly the
//! shape the hosted mode already speaks and one codec serves both. The
//! alternative — reading every column by its type OID — would be a second
//! codec that has to agree with the first about seven tables.
//!
//! **A connection per pass, not a pool.** A pass runs every few minutes; a pool
//! for that is machinery with no user, and it would have to answer for a
//! connection that went stale between passes. The plan asked for a pool size;
//! this is the deviation and the reason for it.
//!
//! **Nothing here has run against a real database.** The SQL is written to be
//! read, every statement it builds is tested as a string, and the first
//! connection anybody makes will be the first real test. See
//! `docs/API-CLIENT-TASKS.md`.

use std::time::{Duration, Instant};

use native_tls::{Certificate, Identity, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_postgres::{Client, NoTls};

use super::remote::Probe;
use super::rows::Row;
use super::{schema, SyncResult, SyncTable, TABLES};

/// What libpq calls `sslmode`, with the same meanings.
///
/// The names are worth keeping exactly: somebody setting this up has a
/// connection string in front of them that uses them, and inventing kinder
/// words would mean translating twice.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    /// No TLS at all. For a database on this machine, and nothing else.
    Disable,
    /// Try TLS; fall back to plaintext if the server will not.
    Prefer,
    /// TLS, but the certificate is not checked. Encrypted against a passer-by,
    /// useless against somebody who can answer for the host.
    #[default]
    Require,
    /// The chain is checked; the hostname is not.
    VerifyCa,
    /// Both are checked. The only one that is proof against an impostor.
    VerifyFull,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub schema: String,
    /// What the database's own logs will call this app. A connection nobody can
    /// identify is a connection nobody can kill.
    pub application_name: String,
    pub connect_timeout_secs: u64,
    /// A query that takes longer than this is cancelled by the server. Zero
    /// means no limit.
    pub statement_timeout_ms: u64,
    pub ssl_mode: SslMode,
    /// A certificate authority to trust in addition to the machine's own.
    pub ca_path: Option<String>,
    /// A client certificate, when the server asks for one. A PKCS#12 bundle, or
    /// a PEM certificate with its key beside it.
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
}

impl Default for DirectConfig {
    fn default() -> Self {
        Self {
            host: "localhost".into(),
            port: 5432,
            database: "figyman".into(),
            user: String::new(),
            schema: "figyman".into(),
            application_name: "FigyMan".into(),
            connect_timeout_secs: 15,
            statement_timeout_ms: 30_000,
            ssl_mode: SslMode::Require,
            ca_path: None,
            client_cert_path: None,
            client_key_path: None,
        }
    }
}

/// An identifier that cannot be anything but an identifier.
///
/// Table and column names come from `TABLES`, which is a constant — but the
/// schema name is the user's, and it ends up in statements that run with
/// whatever rights the connection has. Reduced rather than escaped, like the
/// setup SQL does.
fn ident(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect();
    format!(
        "\"{}\"",
        if cleaned.is_empty() {
            "figyman"
        } else {
            &cleaned
        }
    )
}

/// `SELECT to_jsonb(t) FROM …` — one row, one JSON object, no per-type decoding.
pub fn pull_sql(schema: &str, table: &SyncTable) -> String {
    format!(
        "SELECT to_jsonb(t) FROM {}.{} t \
         WHERE t.updated_at >= $1 ORDER BY t.updated_at ASC LIMIT $2",
        ident(schema),
        ident(table.name)
    )
}

/// The upsert.
///
/// The columns are listed rather than `SELECT *`: a remote schema with a column
/// this build does not know about — `owner`, or something a later version added
/// — must keep it on insert and not have it blanked on update.
pub fn push_sql(schema: &str, table: &SyncTable) -> String {
    let columns = table
        .columns
        .iter()
        .map(|column| ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    let assignments = table
        .columns
        .iter()
        .filter(|column| **column != table.key)
        .map(|column| format!("{} = excluded.{}", ident(column), ident(column)))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "INSERT INTO {schema}.{table} AS r ({columns}) \
         SELECT {columns} FROM jsonb_populate_recordset(null::{schema}.{table}, $1::jsonb) \
         ON CONFLICT ({key}) DO UPDATE SET {assignments} \
         RETURNING to_jsonb(r)",
        schema = ident(schema),
        table = ident(table.name),
        key = ident(table.key),
    )
}

pub struct Direct {
    client: Client,
    schema: String,
}

/// The TLS connector for a mode, or `None` where the mode is plaintext.
fn connector(config: &DirectConfig) -> SyncResult<Option<MakeTlsConnector>> {
    if config.ssl_mode == SslMode::Disable {
        return Ok(None);
    }

    let mut builder = TlsConnector::builder();

    match config.ssl_mode {
        // Encrypted, unverified: enough to stop a passer-by reading it, and no
        // use at all against somebody who can answer for the host.
        SslMode::Prefer | SslMode::Require => {
            builder.danger_accept_invalid_certs(true);
            builder.danger_accept_invalid_hostnames(true);
        }
        // The chain is checked, the name on it is not — which is what people
        // set when the certificate names something the connection string does
        // not, like an internal address.
        SslMode::VerifyCa => {
            builder.danger_accept_invalid_hostnames(true);
        }
        SslMode::VerifyFull | SslMode::Disable => {}
    }

    if let Some(path) = &config.ca_path {
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let certificate = Certificate::from_pem(&bytes)
            .or_else(|_| Certificate::from_der(&bytes))
            .map_err(|e| format!("{path} is not a certificate this can read: {e}"))?;
        builder.add_root_certificate(certificate);
    }

    if let Some(cert_path) = &config.client_cert_path {
        let cert = std::fs::read(cert_path).map_err(|e| format!("{cert_path}: {e}"))?;

        let identity = match &config.client_key_path {
            // A certificate and its key, as two PEM files. Not every platform's
            // TLS will take this — Windows wants a bundle — and the error says
            // which rather than failing at the handshake.
            Some(key_path) => {
                let key = std::fs::read(key_path).map_err(|e| format!("{key_path}: {e}"))?;
                Identity::from_pkcs8(&cert, &key).map_err(|e| {
                    format!(
                        "This platform would not take that certificate and key as a pair ({e}). \
                         A PKCS#12 bundle works everywhere."
                    )
                })?
            }
            // A bundle, with no password. One with a password needs a field of
            // its own, which is a later thing.
            None => Identity::from_pkcs12(&cert, "")
                .map_err(|e| format!("{cert_path} could not be read as a PKCS#12 bundle: {e}"))?,
        };
        builder.identity(identity);
    }

    let connector = builder
        .build()
        .map_err(|e| format!("The TLS settings would not build: {e}"))?;
    Ok(Some(MakeTlsConnector::new(connector)))
}

fn base_config(config: &DirectConfig, password: &str) -> tokio_postgres::Config {
    let mut postgres = tokio_postgres::Config::new();
    postgres
        .host(&config.host)
        .port(config.port)
        .dbname(&config.database)
        .user(&config.user)
        .application_name(&config.application_name)
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs.max(1)));
    if !password.is_empty() {
        postgres.password(password);
    }
    postgres
}

impl Direct {
    /// Opens a connection and leaves it running for the pass.
    ///
    /// The driver splits into a client and a connection future; the future has
    /// to be driven by something or nothing ever moves, so it is spawned and
    /// its handle dropped. When the client goes, the future ends.
    pub async fn connect(config: &DirectConfig, password: &str) -> SyncResult<Self> {
        let postgres = base_config(config, password);

        let client = match connector(config)? {
            None => {
                let (client, connection) = postgres
                    .connect(NoTls)
                    .await
                    .map_err(|e| describe(&e, config))?;
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = connection.await {
                        log::warn!("postgres connection ended: {error}");
                    }
                });
                client
            }
            Some(tls) => {
                let attempt = postgres.connect(tls).await;
                match attempt {
                    Ok((client, connection)) => {
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = connection.await {
                                log::warn!("postgres connection ended: {error}");
                            }
                        });
                        client
                    }
                    // `prefer` is the only mode that may fall back: it means
                    // "encrypt if you can", and a server without TLS is an
                    // answer rather than a failure.
                    Err(error) if config.ssl_mode == SslMode::Prefer => {
                        let (client, connection) = postgres
                            .connect(NoTls)
                            .await
                            .map_err(|_| describe(&error, config))?;
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = connection.await {
                                log::warn!("postgres connection ended: {error}");
                            }
                        });
                        client
                    }
                    Err(error) => return Err(describe(&error, config)),
                }
            }
        };

        // A statement that runs away is cancelled by the server rather than by
        // a timeout here: the server is the one that can actually stop it.
        if config.statement_timeout_ms > 0 {
            let _ = client
                .batch_execute(&format!(
                    "SET statement_timeout = {}",
                    config.statement_timeout_ms
                ))
                .await;
        }

        Ok(Self {
            client,
            /*
              Cleaned once, here, so every path agrees on the name.

              `setup_sql` cleans it too, and used to be the only thing that
              did: the tables were created as `public` while the probe asked
              `information_schema` for `Public ` and the pushes wrote to
              `"Public "`. Nothing errored — the probe simply found none of
              its tables, said all seven were missing, and said it again after
              every Connect, because every Connect created them under the
              other name.
            */
            schema: schema::sanitise(&config.schema),
        })
    }

    /// Creates whatever is missing. Every statement is `IF NOT EXISTS`, so this
    /// is safe on every connection rather than only the first.
    pub async fn migrate(&self) -> SyncResult<()> {
        self.client
            .batch_execute(&schema::setup_sql(&self.schema))
            .await
            .map_err(|e| format!("The schema could not be set up: {}", explain(&e)))
    }

    pub async fn pull(&self, table: &SyncTable, since: i64, limit: usize) -> SyncResult<Vec<Row>> {
        let rows = self
            .client
            .query(&pull_sql(&self.schema, table), &[&since, &(limit as i64)])
            .await
            .map_err(|e| format!("{}: {}", table.name, explain(&e)))?;

        Ok(rows
            .into_iter()
            .filter_map(|row| match row.get::<_, Value>(0) {
                Value::Object(object) => Some(object),
                _ => None,
            })
            .collect())
    }

    pub async fn push(&self, table: &SyncTable, rows: &[Row]) -> SyncResult<Vec<Row>> {
        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let payload = Value::Array(rows.iter().cloned().map(Value::Object).collect());
        let returned = self
            .client
            .query(&push_sql(&self.schema, table), &[&payload])
            .await
            .map_err(|e| format!("{}: {}", table.name, explain(&e)))?;

        Ok(returned
            .into_iter()
            .filter_map(|row| match row.get::<_, Value>(0) {
                Value::Object(object) => Some(object),
                _ => None,
            })
            .collect())
    }

    /// What the connection panel reports: which server, how far away, and
    /// whether the tables are there.
    pub async fn probe(&self) -> Probe {
        let started = Instant::now();

        let version = match self.client.query_one("SELECT version()", &[]).await {
            Ok(row) => row.get::<_, String>(0),
            Err(error) => {
                return Probe {
                    latency_ms: started.elapsed().as_millis() as u64,
                    message: format!("Connected, but the server would not answer: {error}"),
                    ..Default::default()
                }
            }
        };

        let found = self
            .client
            .query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
                &[&self.schema],
            )
            .await
            .map(|rows| {
                rows.into_iter()
                    .map(|row| row.get::<_, String>(0))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let missing: Vec<String> = TABLES
            .iter()
            .filter(|table| !found.iter().any(|name| name == table.name))
            .map(|table| table.name.to_string())
            .collect();

        // The first line of `version()` is the useful part; the rest is the
        // compiler that built it.
        let short: String = version.split(" on ").next().unwrap_or(&version).to_string();

        Probe {
            reachable: true,
            latency_ms: started.elapsed().as_millis() as u64,
            schema_ready: missing.is_empty(),
            // Reaching the database is the whole of what this line reports.
            // Whether its tables are there is a separate answer with a section
            // of its own, and folding the two together made a connection that
            // worked perfectly report itself as a warning.
            message: if missing.is_empty() {
                format!("Connection successful — {short}. Every table is there.")
            } else {
                format!("Connection successful — {short}.")
            },
            missing,
        }
    }
}

/// What Postgres actually said, rather than what the driver's `Display` says.
///
/// `tokio_postgres::Error` prints as the bare words "db error" — the whole of
/// the server's answer is in its source, as a `DbError` carrying the SQLSTATE,
/// the message, and often a detail and a hint that name the exact column or
/// constraint. "collections: db error" is a report with nothing in it; this is
/// the difference between guessing and reading.
fn explain(error: &tokio_postgres::Error) -> String {
    let Some(source) = std::error::Error::source(error) else {
        return error.to_string();
    };

    let Some(db) = source.downcast_ref::<tokio_postgres::error::DbError>() else {
        // Not the server's answer — a broken connection, a TLS failure. Its
        // source is still the useful half.
        return format!("{error}: {source}");
    };

    let mut said = format!("{} [{}]", db.message(), db.code().code());
    if let Some(detail) = db.detail() {
        said.push_str(&format!(" — {detail}"));
    }
    if let Some(hint) = db.hint() {
        said.push_str(&format!(" Hint: {hint}"));
    }
    // Which table and column, where the server named one. This is what turns
    // "permission denied" into "permission denied for the schema you typed".
    if let Some(column) = db.column() {
        said.push_str(&format!(" (column {column})"));
    }
    if let Some(constraint) = db.constraint() {
        said.push_str(&format!(" (constraint {constraint})"));
    }
    said
}

/// What to do about a host that will not resolve.
///
/// Managed Postgres is reached by a name the provider publishes, and two of
/// them fail here for reasons that are nothing to do with a typo:
///
/// - A host published with only an IPv6 address, on a machine with no IPv6
///   route. The resolver says "nodename nor servname provided", which reads
///   like a misspelling and is not one.
/// - A pooled endpoint whose name is close to, but not the same as, the direct
///   one — a `-pooler` suffix, usually.
///
/// No setting in the panel fixes either, so the message says what will. It is
/// written for Postgres in general rather than one provider: this app connects
/// to any server it can reach, and advice that only fires for one vendor's
/// hostnames is advice that is silent exactly when somebody is on another.
fn lookup_hint(host: &str) -> String {
    let lower = host.trim().to_lowercase();

    if lower.contains("-pooler.") {
        return "That is a pooled endpoint. Check it against the connection string in the \
                provider's console — the direct and pooled hosts differ by a suffix, and one \
                of them is often not published outside the provider's own network."
            .into();
    }

    "The name does not resolve to an address this machine can reach. Two things do this and \
     neither is a typo: a host published with only an IPv6 address, on a network with no IPv6 \
     route — and a direct-connection host that the provider only resolves from inside its own \
     network, where a pooled endpoint is the one meant for the outside. Both are in the \
     provider's console, under the connection details."
        .into()
}

/// The username trap that reports itself as a wrong password.
///
/// Several providers put the project or endpoint into the username —
/// `user.endpoint`, or an `endpoint=` option — and given the bare name the
/// server refuses the login. The obvious next move is to go and check the
/// password, which was right all along.
fn username_hint(host: &str, user: &str) -> String {
    let pooled = host.to_lowercase().contains("pooler");
    if pooled && !user.contains('.') {
        return format!(
            "A pooled endpoint often wants the endpoint in the username — \"{user}.<endpoint>\" \
             rather than \"{user}\". Copy the username out of the provider's connection \
             string rather than typing it. "
        );
    }
    String::new()
}

/// A connection failure, said in a way that suggests what to do about it.
fn describe(error: &tokio_postgres::Error, config: &DirectConfig) -> String {
    // The server's own words, not the driver's: `explain` unwraps the
    // `DbError` that "db error" is hiding, which is where the SQLSTATE and the
    // message that names the schema or the role actually live.
    let detail = explain(error);
    let lower = detail.to_lowercase();

    // A name that will not resolve, before anything else: it is the failure
    // that reads least like what it is. The resolver's own words — "nodename
    // nor servname provided" — sound like a typo in the hostname, and the
    // common cause is not a typo at all but a host published with no IPv4
    // address, reached from a machine with no IPv6 route.
    if lower.contains("lookup address")
        || lower.contains("nodename nor servname")
        || lower.contains("name or service not known")
        || lower.contains("failed to lookup")
    {
        return format!(
            "{} could not be looked up. {} {detail}",
            config.host,
            lookup_hint(&config.host)
        );
    }

    if lower.contains("password") || lower.contains("authentication") {
        return format!(
            "The server refused those credentials. {}{detail}",
            username_hint(&config.host, &config.user)
        );
    }
    if lower.contains("does not exist") {
        return format!("No such database or user on that server. {detail}");
    }
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl") {
        return format!(
            "The connection could not be secured at sslmode={:?}. {detail}",
            config.ssl_mode
        );
    }
    format!("Could not reach {}:{}. {detail}", config.host, config.port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::table;

    /*
      One spelling of the schema name, everywhere.

      This is the bug that reports itself as "7 missing" after a Connect that
      appeared to work. `setup_sql` cleans the name; the probe, the pulls and
      the pushes used to take it raw. A name that survives cleaning unchanged —
      `public`, `figyman` — hides the split completely, which is why it went
      unnoticed; a trailing space or a capital letter creates the tables in one
      schema and then looks for them in another, on every attempt.

      Asserted against `setup_sql`'s own output rather than a literal, so the
      two can never drift apart again.
    */
    #[test]
    fn the_schema_is_cleaned_once_so_every_statement_agrees() {
        for typed in ["Public", "public ", " figyman", "Figy-Man", "figyman"] {
            let cleaned = crate::sync::schema::sanitise(typed);

            assert!(
                crate::sync::schema::setup_sql(typed)
                    .contains(&format!("CREATE SCHEMA IF NOT EXISTS {cleaned};")),
                "{typed}: the tables are created under the cleaned name"
            );
            assert!(
                pull_sql(&cleaned, table("collections").unwrap()).contains(&cleaned),
                "{typed}: and read back from the same one"
            );
            assert!(
                push_sql(&cleaned, table("collections").unwrap()).contains(&cleaned),
                "{typed}: and written to the same one"
            );
        }
    }

    /// Cleaning is not a no-op on the names people actually type. If it were,
    /// the test above would pass while proving nothing.
    #[test]
    fn cleaning_actually_changes_some_of_them() {
        assert_eq!(crate::sync::schema::sanitise("Public"), "public");
        assert_eq!(crate::sync::schema::sanitise("public "), "public");
        assert_eq!(crate::sync::schema::sanitise("Figy-Man"), "figyman");
        assert_ne!(crate::sync::schema::sanitise("Public"), "Public");
    }

    /// The failure that reads least like what it is: the resolver says
    /// "nodename nor servname provided", which sounds like a typo, and the
    /// cause is usually a host that this network cannot see at all.
    #[test]
    fn a_name_that_will_not_resolve_is_explained_rather_than_echoed() {
        let hint = lookup_hint("ep-cool-darkness-123456.eu-central-1.aws.neon.tech");
        assert!(hint.contains("IPv6"), "the first cause is named");
        assert!(hint.contains("console"), "and where to look for the right host");
    }

    /// Vendor-neutral on purpose: advice that only fires for one provider's
    /// hostnames is advice that is silent exactly when somebody is on another.
    #[test]
    fn every_host_gets_advice_rather_than_only_the_ones_we_recognise() {
        for host in ["localhost", "db.example.com", "10.0.0.4", "anything.internal"] {
            assert!(
                !lookup_hint(host).is_empty(),
                "{host} was left with the resolver's own words"
            );
        }
    }

    /// A pooled endpoint is recognised by the shape providers actually use,
    /// not by a domain, and gets the advice that fits it.
    #[test]
    fn a_pooled_endpoint_is_told_apart_from_a_direct_one() {
        // On the opening phrase, not on the words "pooled endpoint": the
        // general advice mentions them too, which is the sort of overlap an
        // assertion on a substring quietly passes through.
        let pooled = lookup_hint("ep-cool-darkness-123456-pooler.eu-central-1.aws.neon.tech");
        assert!(pooled.starts_with("That is a pooled endpoint"));
        assert!(!lookup_hint("ep-cool-darkness-123456.eu-central-1.aws.neon.tech")
            .starts_with("That is a pooled endpoint"));
    }

    /// Given the bare name, a pooled endpoint refuses the login — and the
    /// obvious next move is to check the password, which was right all along.
    #[test]
    fn a_pooled_username_missing_its_endpoint_is_named() {
        let hint = username_hint("ep-123-pooler.aws.neon.tech", "postgres");
        assert!(hint.contains("endpoint in the username"));

        assert_eq!(
            username_hint("ep-123-pooler.aws.neon.tech", "postgres.abc123"),
            "",
            "one that already carries it is not second-guessed"
        );
        assert_eq!(
            username_hint("db.internal", "postgres"),
            "",
            "a database that is not pooled has no such rule"
        );
    }

    #[test]
    fn a_pull_asks_postgres_for_the_json_rather_than_decoding_columns() {
        let sql = pull_sql("figyman", table("items").unwrap());
        assert!(sql.contains("SELECT to_jsonb(t)"));
        assert!(sql.contains("FROM \"figyman\".\"items\""));
        // Inclusive, and ordered, for the same reason as the hosted mode: the
        // merge copes with seeing a row twice and cannot cope with missing one.
        assert!(sql.contains("updated_at >= $1"));
        assert!(sql.contains("ORDER BY t.updated_at ASC LIMIT $2"));
    }

    #[test]
    fn a_push_upserts_every_column_it_knows_and_leaves_the_rest() {
        let items = table("items").unwrap();
        let sql = push_sql("figyman", items);

        assert!(sql.starts_with("INSERT INTO \"figyman\".\"items\" AS r ("));
        assert!(sql.contains("jsonb_populate_recordset(null::\"figyman\".\"items\", $1::jsonb)"));
        assert!(sql.contains("ON CONFLICT (\"id\") DO UPDATE SET"));
        assert!(sql.contains("RETURNING to_jsonb(r)"));

        // Every column is named — so a column this build has never heard of is
        // neither inserted as null nor blanked on update.
        for column in items.columns {
            assert!(
                sql.contains(&format!("\"{column}\"")),
                "{column} is missing"
            );
        }
        // And the key is not in the SET list: it is what was matched on.
        assert!(!sql.contains("\"id\" = excluded.\"id\""));
    }

    /// The schema name is the user's and ends up in statements that run with
    /// whatever rights the connection has.
    #[test]
    fn a_schema_name_cannot_carry_anything_but_a_name() {
        let sql = pull_sql("public\"; DROP TABLE users; --", table("items").unwrap());
        assert!(sql.contains("\"publicDROPTABLEusers\""));
        assert!(!sql.contains("DROP TABLE users;"));
        assert!(pull_sql("", table("items").unwrap()).contains("\"figyman\""));
    }

    #[test]
    fn the_modes_are_spelled_the_way_a_connection_string_spells_them() {
        assert_eq!(
            serde_json::to_string(&SslMode::VerifyFull).unwrap(),
            "\"verify-full\""
        );
        assert_eq!(
            serde_json::from_str::<SslMode>("\"verify-ca\"").unwrap(),
            SslMode::VerifyCa
        );
        assert_eq!(SslMode::default(), SslMode::Require);
    }

    /// Plaintext is the one mode with no connector at all; every other builds
    /// one, and only `disable` is allowed to skip it.
    #[test]
    fn only_disable_connects_without_tls() {
        let mut config = DirectConfig {
            ssl_mode: SslMode::Disable,
            ..Default::default()
        };
        assert!(connector(&config).unwrap().is_none());

        for mode in [
            SslMode::Prefer,
            SslMode::Require,
            SslMode::VerifyCa,
            SslMode::VerifyFull,
        ] {
            config.ssl_mode = mode;
            assert!(connector(&config).unwrap().is_some(), "{mode:?}");
        }
    }

    #[test]
    fn a_certificate_file_that_is_not_there_is_named_rather_than_ignored() {
        let config = DirectConfig {
            ssl_mode: SslMode::VerifyFull,
            ca_path: Some("/definitely/not/here.pem".into()),
            ..Default::default()
        };
        // `unwrap_err` would need the success type to be printable, and a TLS
        // connector is not; matching says the same thing.
        let Err(error) = connector(&config) else {
            panic!("a missing certificate file should be an error");
        };
        assert!(error.contains("/definitely/not/here.pem"));
    }

    #[test]
    fn the_connection_carries_a_name_the_server_can_log() {
        let config = DirectConfig::default();
        let postgres = base_config(&config, "");
        assert_eq!(postgres.get_application_name(), Some("FigyMan"));
        assert_eq!(postgres.get_ports(), &[5432]);
    }
}

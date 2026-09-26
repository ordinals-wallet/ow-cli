//! Retry policy and backoff maths shared by HTTP requests and SSE reconnects.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Client-wide retry settings. See [`crate::ClientBuilder::retries`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryConfig {
    /// Retries after the first attempt for idempotent requests. Default 2; 0 disables.
    pub retries: u32,
    /// Base backoff, doubled per retry with jitter. Default 300ms.
    pub retry_delay: Duration,
    /// Longest single wait. A longer `Retry-After` fails fast instead. Default 10s.
    pub max_delay: Duration,
}

impl Default for RetryConfig {
    fn default() -> Self {
        RetryConfig {
            retries: 2,
            retry_delay: Duration::from_millis(300),
            max_delay: Duration::from_secs(10),
        }
    }
}

/// Per-request retry override.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RetryMode {
    /// Retry GET/HEAD/OPTIONS with the client's policy; never retry other methods.
    #[default]
    Default,
    /// Never retry.
    Never,
    /// Retry even a POST with the client's retry count. Only for requests that are safe to repeat.
    Always,
    /// Retry this many times, whatever the method.
    Times(u32),
}

impl RetryMode {
    pub(crate) fn allowed(self, idempotent: bool, cfg: &RetryConfig) -> u32 {
        match self {
            RetryMode::Default if idempotent => cfg.retries,
            RetryMode::Default | RetryMode::Never => 0,
            RetryMode::Always => cfg.retries,
            RetryMode::Times(n) => n,
        }
    }
}

/// True for statuses worth retrying: 429 and 5xx.
pub fn is_retryable_status(status: u16) -> bool {
    status == 429 || status >= 500
}

/// Parses a `Retry-After` header, delta-seconds (fractions allowed) or an
/// IMF-fixdate HTTP date (`Sat, 26 Sep 2026 00:00:03 GMT`), into a wait
/// relative to `now`. Past dates give zero.
pub fn parse_retry_after(value: Option<&str>, now: SystemTime) -> Option<Duration> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    if is_decimal(text) {
        let secs: f64 = text.parse().ok()?;
        return Some(Duration::from_millis((secs * 1000.0).round() as u64));
    }
    let at = parse_imf_fixdate(text)?;
    Some(at.duration_since(now).unwrap_or(Duration::ZERO))
}

/// `^\d+(\.\d+)?$`
fn is_decimal(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.map_or(true, digits)
}

/// `Sun, 06 Nov 1994 08:49:37 GMT` (RFC 9110 §5.6.7).
fn parse_imf_fixdate(s: &str) -> Option<SystemTime> {
    let (_, rest) = s.split_once(", ")?;
    let mut parts = rest.split(' ');
    let day: u32 = parts.next()?.parse().ok()?;
    let mon = parts.next()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| *m == mon)? as u32
        + 1;
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':').map(|p| p.parse::<u64>().ok());
    let (h, mi, se) = (hms.next()??, hms.next()??, hms.next()??);
    if parts.next()? != "GMT"
        || parts.next().is_some()
        || !(1..=31).contains(&day)
        || h > 23
        || mi > 59
        || se > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days
        .checked_mul(86_400)?
        .checked_add((h * 3600 + mi * 60 + se) as i64)?;
    (secs >= 0).then(|| UNIX_EPOCH + Duration::from_secs(secs as u64))
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Delay before retry number `attempt` (1-based).
///
/// A `Retry-After` wins when present: returned as is when it is at most
/// `max_delay`, otherwise `None` (do not retry). Without one: exponential
/// backoff with equal jitter, `exp = min(max_delay, retry_delay * 2^(attempt-1))`,
/// `delay = round(exp/2 + random * exp/2)`, with `random` in `[0, 1]`.
///
/// ```
/// use std::time::Duration;
/// use ordinalswallet::retry::compute_retry_delay;
/// let ms = |d: Option<Duration>| d.map(|d| d.as_millis());
/// let (base, max) = (Duration::from_millis(100), Duration::from_secs(1));
/// assert_eq!(ms(compute_retry_delay(3, base, max, None, 1.0)), Some(400));
/// assert_eq!(ms(compute_retry_delay(1, base, max, Some("0.5"), 0.0)), Some(500));
/// assert_eq!(ms(compute_retry_delay(1, base, max, Some("5"), 0.0)), None);
/// ```
pub fn compute_retry_delay(
    attempt: u32,
    retry_delay: Duration,
    max_delay: Duration,
    retry_after: Option<&str>,
    random: f64,
) -> Option<Duration> {
    if let Some(server) = parse_retry_after(retry_after, SystemTime::now()) {
        return (server <= max_delay).then_some(server);
    }
    let base = retry_delay.as_millis() as f64;
    let exp = (base * 2f64.powi(attempt.saturating_sub(1).min(60) as i32))
        .min(max_delay.as_millis() as f64);
    Some(Duration::from_millis(
        (exp / 2.0 + random * (exp / 2.0)).round() as u64,
    ))
}

/// A uniform value in `[0, 1)`, for jitter. Not cryptographic.
pub(crate) fn jitter() -> f64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    (h.finish() >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_is_in_range() {
        for _ in 0..1000 {
            assert!((0.0..1.0).contains(&jitter()));
        }
    }

    #[test]
    fn retry_modes() {
        let cfg = RetryConfig::default();
        assert_eq!(RetryMode::Default.allowed(true, &cfg), 2);
        assert_eq!(RetryMode::Default.allowed(false, &cfg), 0);
        assert_eq!(RetryMode::Always.allowed(false, &cfg), 2);
        assert_eq!(RetryMode::Never.allowed(true, &cfg), 0);
        assert_eq!(RetryMode::Times(5).allowed(false, &cfg), 5);
    }

    #[test]
    fn http_dates() {
        let t = parse_imf_fixdate("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
        assert_eq!(t.duration_since(UNIX_EPOCH).unwrap().as_secs(), 784_111_777);
        let t = parse_imf_fixdate("Thu, 01 Jan 1970 00:00:00 GMT").unwrap();
        assert_eq!(t, UNIX_EPOCH);
        let t = parse_imf_fixdate("Tue, 29 Feb 2028 12:00:00 GMT").unwrap();
        assert_eq!(
            t.duration_since(UNIX_EPOCH).unwrap().as_secs(),
            1_835_438_400
        );
        assert!(parse_imf_fixdate("Sun, 06 Foo 1994 08:49:37 GMT").is_none());
        assert!(parse_imf_fixdate("Sun, 06 Nov 1994 08:49:37 PST").is_none());
        assert!(parse_imf_fixdate("garbage").is_none());
    }
}

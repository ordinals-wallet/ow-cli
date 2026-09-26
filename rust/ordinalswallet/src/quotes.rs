//! Live BTC/USD and per-collection fair lines.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::charts::dedupe;
use crate::client::{Client, Req};
use crate::error::{Error, Result};
use crate::feeds::FEED_RETRIES;
use crate::stream::{subscribe, CloseHandle, StreamEvent, SubscribeOptions, Subscription};

/// Max collections per quotes request or stream.
pub const QUOTES_LIMIT: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BtcQuote {
    pub usd: f64,
    /// Unix seconds.
    pub ts: i64,
}

/// A collection's live fair line (the chart's smoothed median, not a valuation).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MarkQuote {
    pub slug: String,
    pub fair_sats: f64,
    pub p10_sats: f64,
    pub p90_sats: f64,
    pub samples: u64,
    /// Percent change over the past week.
    #[serde(default)]
    pub change_week: Option<f64>,
    /// Unix seconds.
    pub ts: i64,
}

/// `GET /quotes`, or the `snapshot` event of `/quotes/stream`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuotesSnapshot {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub btc: Option<BtcQuote>,
    #[serde(default)]
    pub marks: Vec<MarkQuote>,
    pub ts: i64,
}

/// What a [`QuotesStream`] yields. The snapshot is also replayed as `Btc` and
/// `Mark` items, so callers can rely on those alone.
#[derive(Debug)]
pub enum QuotesStreamEvent {
    Open,
    Snapshot(QuotesSnapshot),
    Btc(BtcQuote),
    Mark(MarkQuote),
    /// When `fatal` the iterator ends after this item; otherwise it reconnects.
    Error {
        error: Error,
        fatal: bool,
    },
}

/// A live quotes subscription.
#[derive(Debug)]
pub struct QuotesStream {
    sub: Subscription,
    queue: VecDeque<QuotesStreamEvent>,
}

impl QuotesStream {
    pub fn close_handle(&self) -> CloseHandle {
        self.sub.close_handle()
    }

    pub fn close(&mut self) {
        self.sub.close();
    }
}

impl Iterator for QuotesStream {
    type Item = QuotesStreamEvent;

    fn next(&mut self) -> Option<QuotesStreamEvent> {
        loop {
            if let Some(q) = self.queue.pop_front() {
                return Some(q);
            }
            let ev = match self.sub.next()? {
                StreamEvent::Open => return Some(QuotesStreamEvent::Open),
                StreamEvent::Error { error, fatal } => {
                    return Some(QuotesStreamEvent::Error { error, fatal })
                }
                StreamEvent::Event(ev) => ev,
            };
            let decode_err = |source| QuotesStreamEvent::Error {
                error: Error::Decode {
                    method: "SSE".into(),
                    path: ev.event.clone(),
                    source,
                },
                fatal: false,
            };
            match ev.event.as_str() {
                "snapshot" => match serde_json::from_str::<QuotesSnapshot>(&ev.data) {
                    Ok(snap) => {
                        if let Some(btc) = &snap.btc {
                            self.queue.push_back(QuotesStreamEvent::Btc(btc.clone()));
                        }
                        self.queue
                            .extend(snap.marks.iter().cloned().map(QuotesStreamEvent::Mark));
                        return Some(QuotesStreamEvent::Snapshot(snap));
                    }
                    Err(e) => return Some(decode_err(e)),
                },
                "btc" => {
                    return Some(
                        serde_json::from_str(&ev.data)
                            .map_or_else(decode_err, QuotesStreamEvent::Btc),
                    )
                }
                "mark" => {
                    return Some(
                        serde_json::from_str(&ev.data)
                            .map_or_else(decode_err, QuotesStreamEvent::Mark),
                    )
                }
                _ => continue,
            }
        }
    }
}

/// Quote endpoints. Get one with [`Client::quotes`].
#[derive(Clone, Copy, Debug)]
pub struct QuotesApi<'a>(pub(crate) &'a Client);

impl Client {
    /// BTC/USD and fair-line quotes.
    pub fn quotes(&self) -> QuotesApi<'_> {
        QuotesApi(self)
    }
}

impl QuotesApi<'_> {
    /// Live BTC/USD and each collection's fair line. `GET /quotes`. Slugs are
    /// deduplicated; more than 64 are split into several requests and merged.
    pub fn get<S: AsRef<str>>(&self, slugs: &[S]) -> Result<QuotesSnapshot> {
        let unique = dedupe(slugs);
        if unique.is_empty() {
            return self.0.json(Req::get("/quotes".into()).retry(FEED_RETRIES));
        }
        let mut merged: Option<QuotesSnapshot> = None;
        for chunk in unique.chunks(QUOTES_LIMIT) {
            let page: QuotesSnapshot = self.0.json(
                Req::get("/quotes".into())
                    .query("collections", chunk.join(","))
                    .retry(FEED_RETRIES),
            )?;
            match merged.as_mut() {
                None => merged = Some(page),
                Some(m) => m.marks.extend(page.marks),
            }
        }
        Ok(merged.expect("at least one chunk"))
    }

    /// Streams BTC/USD and fair-line updates for up to 64 collections
    /// (`GET /quotes/stream`). Fails with [`Error::InvalidInput`] for more.
    ///
    /// ```no_run
    /// use ordinalswallet::quotes::QuotesStreamEvent;
    /// let client = ordinalswallet::Client::new();
    /// for ev in client.quotes().stream(&["bitcoin-puppets"], Default::default())? {
    ///     match ev {
    ///         QuotesStreamEvent::Btc(b) => println!("BTC ${}", b.usd),
    ///         QuotesStreamEvent::Mark(m) => println!("{} fair {} sats", m.slug, m.fair_sats),
    ///         _ => {}
    ///     }
    /// }
    /// # Ok::<(), ordinalswallet::Error>(())
    /// ```
    pub fn stream<S: AsRef<str>>(
        &self,
        slugs: &[S],
        opts: SubscribeOptions,
    ) -> Result<QuotesStream> {
        let unique = dedupe(slugs);
        if unique.len() > QUOTES_LIMIT {
            return Err(Error::InvalidInput(format!(
                "quotes stream accepts at most {QUOTES_LIMIT} collections (got {})",
                unique.len()
            )));
        }
        let query = if unique.is_empty() {
            vec![]
        } else {
            vec![("collections", unique.join(","))]
        };
        Ok(QuotesStream {
            sub: subscribe(self.0, self.0.url("/quotes/stream", &query), opts),
            queue: VecDeque::new(),
        })
    }
}

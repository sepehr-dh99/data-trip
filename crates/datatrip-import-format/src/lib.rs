//! Import data (v0.16), the pure part: text decoding (UTF-8 / UTF-16 / Latin-1), a streaming CSV parser, a
//! streaming JSON-array element splitter, format detection, column type inference, value conversion for a
//! target column type (numbers, booleans, dates with a chosen format → ISO, NULL text → NULL) and the batched
//! INSERT statements per dialect. The byte-oriented preview is shared by native and Wasm.

pub mod preview;

/// SQL dialects the importer writes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
    Mssql,
}

// ---------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    /// Windows-1252 (a superset of ISO-8859-1 for printable text).
    Latin1,
}

impl Encoding {
    pub fn parse(s: &str) -> Option<Encoding> {
        match s.trim().to_ascii_lowercase().as_str() {
            "utf8" | "utf-8" => Some(Encoding::Utf8),
            "utf16" | "utf-16" | "utf16le" | "utf-16le" => Some(Encoding::Utf16Le),
            "utf16be" | "utf-16be" => Some(Encoding::Utf16Be),
            "latin1" | "latin-1" | "iso-8859-1" | "windows-1252" | "cp1252" => {
                Some(Encoding::Latin1)
            }
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf8",
            Encoding::Utf16Le => "utf16le",
            Encoding::Utf16Be => "utf16be",
            Encoding::Latin1 => "latin1",
        }
    }
}

/// Windows-1252 code points for bytes 0x80..=0x9F (0 = undefined → the byte's Latin-1 value).
const CP1252: [u32; 32] = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC,
    0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
];

fn latin1_char(b: u8) -> char {
    if (0x80..=0x9F).contains(&b) {
        let cp = CP1252[(b - 0x80) as usize];
        if cp != 0 {
            if let Some(c) = char::from_u32(cp) {
                return c;
            }
        }
    }
    b as char
}

/// Detects the encoding from the first bytes of a file: BOM, valid UTF-8, UTF-16 without BOM (zero bytes
/// in every other position), else Latin-1. Returns a note when the guess is worth telling the user.
pub fn detect_encoding(head: &[u8]) -> (Encoding, Option<String>) {
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (Encoding::Utf8, None);
    }
    if head.starts_with(&[0xFF, 0xFE]) {
        return (
            Encoding::Utf16Le,
            Some("UTF-16 (little endian) file".into()),
        );
    }
    if head.starts_with(&[0xFE, 0xFF]) {
        return (Encoding::Utf16Be, Some("UTF-16 (big endian) file".into()));
    }
    let probe = &head[..head.len().min(4096)];
    if probe.len() >= 4 {
        let even_zero = probe.iter().step_by(2).filter(|b| **b == 0).count();
        let odd_zero = probe.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
        let half = probe.len() / 2;
        if odd_zero * 10 > half * 4 && even_zero * 10 < half {
            return (
                Encoding::Utf16Le,
                Some("Looks like UTF-16 (little endian) without a byte order mark".into()),
            );
        }
        if even_zero * 10 > half * 4 && odd_zero * 10 < half {
            return (
                Encoding::Utf16Be,
                Some("Looks like UTF-16 (big endian) without a byte order mark".into()),
            );
        }
    }
    match std::str::from_utf8(head) {
        Ok(_) => (Encoding::Utf8, None),
        // Only an incomplete sequence at the very end (the sample was cut mid-character): still UTF-8.
        Err(e) if e.error_len().is_none() => (Encoding::Utf8, None),
        Err(_) => (
            Encoding::Latin1,
            Some("The file isn't valid UTF-8, so it is read as Latin-1 (Windows-1252). Pick another encoding if characters look wrong.".into()),
        ),
    }
}

/// Incremental decoder: feed byte chunks, get text. A byte order mark at the start is dropped.
pub struct Decoder {
    enc: Encoding,
    pending: Vec<u8>,
    started: bool,
    /// Characters that could not be decoded (replaced by U+FFFD).
    pub replaced: u64,
}

impl Decoder {
    pub fn new(enc: Encoding) -> Decoder {
        Decoder {
            enc,
            pending: Vec::new(),
            started: false,
            replaced: 0,
        }
    }

    /// Decodes `bytes`; with `last`, an incomplete trailing sequence becomes U+FFFD.
    pub fn feed(&mut self, bytes: &[u8], last: bool) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);
        let mut start = 0usize;
        if !self.started {
            let bom: &[u8] = match self.enc {
                Encoding::Utf8 => &[0xEF, 0xBB, 0xBF],
                Encoding::Utf16Le => &[0xFF, 0xFE],
                Encoding::Utf16Be => &[0xFE, 0xFF],
                Encoding::Latin1 => &[],
            };
            if buf.len() < bom.len() && !last && bom.starts_with(&buf) {
                self.pending = buf;
                return String::new();
            }
            if !bom.is_empty() && buf.starts_with(bom) {
                start = bom.len();
            }
            self.started = true;
        }
        let data = &buf[start..];
        let mut out = String::with_capacity(data.len());
        match self.enc {
            Encoding::Latin1 => {
                for &b in data {
                    out.push(latin1_char(b));
                }
            }
            Encoding::Utf8 => {
                let mut rest = data;
                loop {
                    match std::str::from_utf8(rest) {
                        Ok(s) => {
                            out.push_str(s);
                            break;
                        }
                        Err(e) => {
                            let good = e.valid_up_to();
                            // Safe: the prefix was validated.
                            out.push_str(std::str::from_utf8(&rest[..good]).unwrap_or(""));
                            match e.error_len() {
                                Some(n) => {
                                    out.push('\u{FFFD}');
                                    self.replaced += 1;
                                    rest = &rest[good + n..];
                                }
                                None => {
                                    if last {
                                        out.push('\u{FFFD}');
                                        self.replaced += 1;
                                    } else {
                                        self.pending = rest[good..].to_vec();
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let le = self.enc == Encoding::Utf16Le;
                let n = data.len() / 2 * 2;
                let mut units: Vec<u16> = Vec::with_capacity(n / 2);
                for ch in data[..n].chunks(2) {
                    units.push(if le {
                        u16::from_le_bytes([ch[0], ch[1]])
                    } else {
                        u16::from_be_bytes([ch[0], ch[1]])
                    });
                }
                let mut keep: Vec<u8> = data[n..].to_vec();
                // A high surrogate at the end waits for its partner.
                if !last {
                    if let Some(&u) = units.last() {
                        if (0xD800..0xDC00).contains(&u) {
                            units.pop();
                            let mut b = if le {
                                u.to_le_bytes().to_vec()
                            } else {
                                u.to_be_bytes().to_vec()
                            };
                            b.extend_from_slice(&keep);
                            keep = b;
                        }
                    }
                }
                for r in std::char::decode_utf16(units.iter().copied()) {
                    match r {
                        Ok(c) => out.push(c),
                        Err(_) => {
                            out.push('\u{FFFD}');
                            self.replaced += 1;
                        }
                    }
                }
                if last {
                    if !keep.is_empty() {
                        out.push('\u{FFFD}');
                        self.replaced += 1;
                    }
                } else {
                    self.pending = keep;
                }
            }
        }
        out
    }
}

/// Text decoded as Latin-1 that is really UTF-8 shows pairs like "Ã©": worth a hint.
pub fn looks_like_mojibake(s: &str) -> bool {
    let mut prev = '\0';
    for c in s.chars() {
        if (prev == 'Ã' || prev == 'Â') && ('\u{80}'..='\u{BF}').contains(&c) {
            return true;
        }
        if (prev == 'Ã' || prev == 'Â') && "‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ©®".contains(c)
        {
            return true;
        }
        prev = c;
    }
    false
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct CsvRecord {
    /// 1-based line where the record starts.
    pub line: u64,
    pub fields: Vec<String>,
}

/// Streaming CSV parser: quotes (doubled quote = literal quote), quoted delimiters and line breaks,
/// CRLF / LF / CR line ends. Blank lines are skipped.
pub struct CsvParser {
    delim: char,
    quote: Option<char>,
    field: String,
    record: Vec<String>,
    in_quotes: bool,
    after_quote: bool,
    pending_cr: bool,
    /// Something (a char or a delimiter) was read for the current record.
    in_record: bool,
    line: u64,
    rec_line: u64,
    /// Line where an unterminated quote started (set by `finish`).
    pub unterminated: Option<u64>,
}

impl CsvParser {
    pub fn new(delim: char, quote: Option<char>) -> CsvParser {
        CsvParser {
            delim,
            quote,
            field: String::new(),
            record: Vec::new(),
            in_quotes: false,
            after_quote: false,
            pending_cr: false,
            in_record: false,
            line: 1,
            rec_line: 1,
            unterminated: None,
        }
    }

    fn end_field(&mut self) {
        self.record.push(std::mem::take(&mut self.field));
    }

    fn end_record(&mut self, out: &mut Vec<CsvRecord>) {
        self.end_field();
        let fields = std::mem::take(&mut self.record);
        let blank = fields.len() == 1 && fields[0].is_empty();
        if self.in_record && !blank {
            out.push(CsvRecord {
                line: self.rec_line,
                fields,
            });
        }
        self.in_record = false;
    }

    pub fn feed(&mut self, text: &str, out: &mut Vec<CsvRecord>) {
        for c in text.chars() {
            if self.in_quotes {
                if Some(c) == self.quote {
                    self.in_quotes = false;
                    self.after_quote = true;
                } else {
                    if c == '\n' {
                        self.line += 1;
                    }
                    self.field.push(c);
                }
                continue;
            }
            if self.after_quote {
                self.after_quote = false;
                if Some(c) == self.quote {
                    // "" inside a quoted field: a literal quote.
                    self.field.push(c);
                    self.in_quotes = true;
                    continue;
                }
            }
            if self.pending_cr {
                self.pending_cr = false;
                if c == '\n' {
                    continue;
                }
            }
            if c == '\r' || c == '\n' {
                self.line += 1;
                if c == '\r' {
                    self.pending_cr = true;
                }
                self.end_record(out);
                continue;
            }
            if !self.in_record {
                self.in_record = true;
                self.rec_line = self.line;
            }
            if c == self.delim {
                self.end_field();
            } else if Some(c) == self.quote && self.field.is_empty() {
                self.in_quotes = true;
            } else {
                self.field.push(c);
            }
        }
    }

    /// End of input: emits the last record (also an unterminated quoted one).
    pub fn finish(&mut self, out: &mut Vec<CsvRecord>) {
        if self.in_quotes {
            self.unterminated = Some(self.rec_line);
            self.in_quotes = false;
        }
        if self.in_record || !self.field.is_empty() || !self.record.is_empty() {
            self.in_record = true;
            self.end_record(out);
        }
    }

    /// Current 1-based line (for progress / errors).
    pub fn line(&self) -> u64 {
        self.line
    }
}

/// Parses a whole text (tests, previews).
pub fn parse_csv(text: &str, delim: char, quote: Option<char>) -> Vec<CsvRecord> {
    let mut p = CsvParser::new(delim, quote);
    let mut out = Vec::new();
    p.feed(text, &mut out);
    p.finish(&mut out);
    out
}

// ---------------------------------------------------------------------------
// JSON array splitting (elements are parsed by serde_json in import.rs)
// ---------------------------------------------------------------------------

/// Splits a top-level JSON array into the source text of its elements, streaming.
pub struct JsonArraySplitter {
    started: bool,
    done: bool,
    depth: u32,
    in_str: bool,
    esc: bool,
    buf: String,
    line: u64,
    elem_line: u64,
    /// Something other than whitespace before '[' (not an array).
    pub not_array: bool,
}

impl Default for JsonArraySplitter {
    fn default() -> Self {
        JsonArraySplitter {
            started: false,
            done: false,
            depth: 0,
            in_str: false,
            esc: false,
            buf: String::new(),
            line: 1,
            elem_line: 1,
            not_array: false,
        }
    }
}

impl JsonArraySplitter {
    /// Feeds text; complete elements are pushed as (line where it starts, text).
    pub fn feed(&mut self, text: &str, out: &mut Vec<(u64, String)>) {
        for c in text.chars() {
            if c == '\n' {
                self.line += 1;
            }
            if self.done || self.not_array {
                continue;
            }
            if !self.started {
                if c == '[' {
                    self.started = true;
                    self.depth = 1;
                } else if !c.is_whitespace() && c != '\u{FEFF}' {
                    self.not_array = true;
                }
                continue;
            }
            if self.in_str {
                self.buf.push(c);
                if self.esc {
                    self.esc = false;
                } else if c == '\\' {
                    self.esc = true;
                } else if c == '"' {
                    self.in_str = false;
                }
                continue;
            }
            match c {
                '"' => {
                    self.mark_start();
                    self.in_str = true;
                    self.buf.push(c);
                }
                '[' | '{' => {
                    self.mark_start();
                    self.depth += 1;
                    self.buf.push(c);
                }
                ']' | '}' => {
                    if self.depth == 1 {
                        // The closing bracket of the top-level array.
                        self.flush(out);
                        self.done = true;
                    } else {
                        self.depth -= 1;
                        self.buf.push(c);
                    }
                }
                ',' if self.depth == 1 => self.flush(out),
                _ => {
                    if !c.is_whitespace() {
                        self.mark_start();
                    }
                    if !self.buf.is_empty() || !c.is_whitespace() {
                        self.buf.push(c);
                    }
                }
            }
        }
    }

    fn mark_start(&mut self) {
        if self.buf.is_empty() {
            self.elem_line = self.line;
        }
    }

    fn flush(&mut self, out: &mut Vec<(u64, String)>) {
        let t = self.buf.trim();
        if !t.is_empty() {
            out.push((self.elem_line, t.to_string()));
        }
        self.buf.clear();
    }

    /// True once the closing ']' was read.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// End of input without ']' : the last element (if any) is emitted; returns false when the array was
    /// never closed.
    pub fn finish(&mut self, out: &mut Vec<(u64, String)>) -> bool {
        if self.done {
            return true;
        }
        if self.started {
            self.flush(out);
        }
        false
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SourceKind {
    Csv,
    JsonArray,
    Ndjson,
}

impl SourceKind {
    pub fn id(self) -> &'static str {
        match self {
            SourceKind::Csv => "csv",
            SourceKind::JsonArray => "json",
            SourceKind::Ndjson => "ndjson",
        }
    }

    pub fn parse(s: &str) -> Option<SourceKind> {
        match s {
            "csv" | "tsv" | "txt" => Some(SourceKind::Csv),
            "json" => Some(SourceKind::JsonArray),
            "ndjson" | "jsonl" => Some(SourceKind::Ndjson),
            _ => None,
        }
    }
}

/// File kind from the extension, then the content: `[` → JSON array, `{` → NDJSON.
pub fn sniff_kind(path: &str, text: &str) -> SourceKind {
    let lower = path.to_ascii_lowercase();
    let first = text
        .chars()
        .find(|c| !c.is_whitespace() && *c != '\u{FEFF}');
    if lower.ends_with(".ndjson") || lower.ends_with(".jsonl") {
        return SourceKind::Ndjson;
    }
    if lower.ends_with(".json") {
        return if first == Some('{') {
            SourceKind::Ndjson
        } else {
            SourceKind::JsonArray
        };
    }
    if lower.ends_with(".csv") || lower.ends_with(".tsv") || lower.ends_with(".tab") {
        return SourceKind::Csv;
    }
    match first {
        Some('[') => SourceKind::JsonArray,
        Some('{') => SourceKind::Ndjson,
        _ => SourceKind::Csv,
    }
}

/// The delimiter giving the most consistent field count over the sample (comma when nothing fits).
pub fn detect_delimiter(path: &str, sample: &str, quote: Option<char>) -> char {
    let lower = path.to_ascii_lowercase();
    let preferred = if lower.ends_with(".tsv") || lower.ends_with(".tab") {
        '\t'
    } else {
        ','
    };
    // Only complete lines (the sample may end mid-record).
    let cut = match sample.rfind('\n') {
        Some(i) if i + 1 < sample.len() => &sample[..i + 1],
        _ => sample,
    };
    let mut best = (preferred, 0.0f64, 0usize);
    for d in [preferred, ',', ';', '\t', '|'] {
        let recs = parse_csv(cut, d, quote);
        let recs: Vec<&CsvRecord> = recs.iter().take(40).collect();
        if recs.is_empty() {
            continue;
        }
        let mut counts: Vec<usize> = recs.iter().map(|r| r.fields.len()).collect();
        counts.sort_unstable();
        // Mode of the field counts.
        let (mut mode, mut mode_n, mut i) = (0usize, 0usize, 0usize);
        while i < counts.len() {
            let mut j = i;
            while j < counts.len() && counts[j] == counts[i] {
                j += 1;
            }
            if j - i > mode_n || (j - i == mode_n && counts[i] > mode) {
                mode = counts[i];
                mode_n = j - i;
            }
            i = j;
        }
        if mode < 2 {
            continue;
        }
        let consistency = mode_n as f64 / recs.len() as f64;
        if consistency > best.1 + 1e-9 || ((consistency - best.1).abs() < 1e-9 && mode > best.2) {
            best = (d, consistency, mode);
        }
    }
    best.0
}

/// The first row is a header when it has no number / date / boolean-looking values, no empties and no
/// duplicates (one row only: header).
pub fn detect_header(rows: &[Vec<String>]) -> bool {
    let first = match rows.first() {
        Some(r) => r,
        None => return true,
    };
    if first.iter().any(|v| v.trim().is_empty()) {
        return false;
    }
    if first.iter().any(|v| {
        let k = classify_value(v.trim(), None);
        matches!(
            k,
            Kind::Int | Kind::BigInt | Kind::Decimal | Kind::Date | Kind::Timestamp
        )
    }) {
        return false;
    }
    let mut seen: Vec<String> = Vec::new();
    for v in first {
        let k = v.trim().to_lowercase();
        if seen.contains(&k) {
            return false;
        }
        seen.push(k);
    }
    true
}

/// Unique, non-empty column names ("column3" for empty ones, "_2" suffixes for duplicates).
pub fn unique_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(names.len());
    for (i, n) in names.iter().enumerate() {
        let base = if n.trim().is_empty() {
            format!("column{}", i + 1)
        } else {
            n.trim().to_string()
        };
        let mut name = base.clone();
        let mut k = 2;
        while out.iter().any(|o| o.eq_ignore_ascii_case(&name)) {
            name = format!("{}_{}", base, k);
            k += 1;
        }
        out.push(name);
    }
    out
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tok {
    Year4,
    Year2,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Frac,
    Lit(char),
}

/// A user date format such as `dd/MM/yyyy HH:mm:ss` (y year, M month, d day, H hour, m minute, s second,
/// S / f fraction; Y and D are accepted for year / day; lower-case `mm` before any hour means month).
#[derive(Clone, Debug, PartialEq)]
pub struct DateFormat {
    toks: Vec<(Tok, usize)>,
    pub has_time: bool,
}

impl DateFormat {
    pub fn parse(spec: &str) -> Option<DateFormat> {
        let chars: Vec<char> = spec.trim().chars().collect();
        if chars.is_empty() {
            return None;
        }
        let mut toks: Vec<(Tok, usize)> = Vec::new();
        let mut seen_hour = false;
        let mut seen_month = false;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let mut j = i;
            while j < chars.len() && chars[j] == c {
                j += 1;
            }
            let n = j - i;
            let tok = match c {
                'y' | 'Y' => Some(if n <= 2 { Tok::Year2 } else { Tok::Year4 }),
                'M' => Some(Tok::Month),
                'd' | 'D' => Some(Tok::Day),
                'H' | 'h' => Some(Tok::Hour),
                'm' => Some(if !seen_hour && !seen_month {
                    Tok::Month
                } else {
                    Tok::Minute
                }),
                's' => Some(Tok::Second),
                'S' | 'f' | 'F' => Some(Tok::Frac),
                _ => None,
            };
            match tok {
                Some(t) => {
                    if t == Tok::Hour {
                        seen_hour = true;
                    }
                    if t == Tok::Month {
                        seen_month = true;
                    }
                    toks.push((t, n));
                    i = j;
                }
                None => {
                    toks.push((Tok::Lit(c), 1));
                    i += 1;
                }
            }
        }
        let has = |t: Tok| toks.iter().any(|(x, _)| *x == t);
        if !(has(Tok::Year4) || has(Tok::Year2)) || !has(Tok::Month) || !has(Tok::Day) {
            return None;
        }
        let has_time = has(Tok::Hour);
        Some(DateFormat { toks, has_time })
    }
}

/// A parsed date / timestamp.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateTimeParts {
    pub y: i32,
    pub mo: u32,
    pub d: u32,
    pub h: u32,
    pub mi: u32,
    pub s: u32,
    /// Fraction digits as written ("" = none).
    pub frac: String,
    pub has_time: bool,
    /// "Z", "+02:00", … (as normalized), when present.
    pub tz: Option<String>,
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

impl DateTimeParts {
    fn valid(&self) -> bool {
        self.mo >= 1
            && self.mo <= 12
            && self.d >= 1
            && self.d <= days_in_month(self.y, self.mo)
            && self.h <= 23
            && self.mi <= 59
            && self.s <= 59
            && self.y >= 1
            && self.y <= 9999
    }

    pub fn iso_date(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.y, self.mo, self.d)
    }

    /// `YYYY-MM-DD HH:MM:SS[.fff][tz]`.
    pub fn iso_timestamp(&self, keep_tz: bool) -> String {
        let mut s = format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            self.y, self.mo, self.d, self.h, self.mi, self.s
        );
        if !self.frac.is_empty() {
            s.push('.');
            s.push_str(&self.frac);
        }
        if keep_tz {
            if let Some(tz) = &self.tz {
                s.push_str(if tz == "Z" { "+00:00" } else { tz });
            }
        }
        s
    }
}

fn take_digits(c: &[char], i: &mut usize, min: usize, max: usize) -> Option<u32> {
    let start = *i;
    while *i < c.len() && *i - start < max && c[*i].is_ascii_digit() {
        *i += 1;
    }
    if *i - start < min {
        return None;
    }
    c[start..*i].iter().collect::<String>().parse().ok()
}

fn take_tz(c: &[char], i: &mut usize) -> Option<Option<String>> {
    while *i < c.len() && c[*i] == ' ' {
        *i += 1;
    }
    if *i >= c.len() {
        return Some(None);
    }
    if c[*i] == 'Z' || c[*i] == 'z' {
        *i += 1;
        return Some(Some("Z".into()));
    }
    if c[*i] == '+' || c[*i] == '-' {
        let sign = c[*i];
        *i += 1;
        let hh = take_digits(c, i, 2, 2)?;
        if *i < c.len() && c[*i] == ':' {
            *i += 1;
        }
        let mm = if *i < c.len() {
            take_digits(c, i, 2, 2).unwrap_or(0)
        } else {
            0
        };
        if hh > 14 || mm > 59 {
            return None;
        }
        return Some(Some(format!("{}{:02}:{:02}", sign, hh, mm)));
    }
    None
}

/// Parses with a user format (whitespace around the value ignored; an optional time-zone suffix allowed).
pub fn parse_with(fmt: &DateFormat, s: &str) -> Option<DateTimeParts> {
    let c: Vec<char> = s.trim().chars().collect();
    let mut i = 0usize;
    let mut p = DateTimeParts {
        y: 0,
        mo: 0,
        d: 0,
        h: 0,
        mi: 0,
        s: 0,
        frac: String::new(),
        has_time: fmt.has_time,
        tz: None,
    };
    let n = fmt.toks.len();
    for k in 0..n {
        let (t, len) = fmt.toks[k];
        // Adjacent numeric fields (yyyyMMdd): read exactly the written width.
        let next_numeric = k + 1 < n && !matches!(fmt.toks[k + 1].0, Tok::Lit(_));
        let (min, max) = if next_numeric {
            (len.max(1), len.max(1))
        } else {
            (1, 2)
        };
        match t {
            Tok::Lit(ch) => {
                if i < c.len()
                    && (c[i] == ch || (ch == ' ' && c[i] == 'T') || (ch == 'T' && c[i] == ' '))
                {
                    i += 1;
                } else {
                    return None;
                }
            }
            Tok::Year4 => p.y = take_digits(&c, &mut i, 4, 4)? as i32,
            Tok::Year2 => {
                let y = take_digits(&c, &mut i, 2, 2)? as i32;
                p.y = if y >= 70 { 1900 + y } else { 2000 + y };
            }
            Tok::Month => p.mo = take_digits(&c, &mut i, min, max)?,
            Tok::Day => p.d = take_digits(&c, &mut i, min, max)?,
            Tok::Hour => p.h = take_digits(&c, &mut i, min, max)?,
            Tok::Minute => p.mi = take_digits(&c, &mut i, min, max)?,
            Tok::Second => p.s = take_digits(&c, &mut i, min, max)?,
            Tok::Frac => {
                let start = i;
                while i < c.len() && c[i].is_ascii_digit() && i - start < 9 {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                p.frac = c[start..i].iter().collect();
            }
        }
    }
    // Optional ".fff" after seconds when the format has none.
    if fmt.has_time && i < c.len() && c[i] == '.' && !fmt.toks.iter().any(|(t, _)| *t == Tok::Frac)
    {
        i += 1;
        let start = i;
        while i < c.len() && c[i].is_ascii_digit() && i - start < 9 {
            i += 1;
        }
        p.frac = c[start..i].iter().collect();
    }
    p.tz = take_tz(&c, &mut i)?;
    if i != c.len() || !p.valid() {
        return None;
    }
    Some(p)
}

/// ISO-ish values without a format: `YYYY-MM-DD`, `YYYY/MM/DD`, optionally followed by ` ` or `T`
/// `HH:MM[:SS[.fff]]` and a zone (`Z`, `±HH[:MM]`).
pub fn parse_auto(s: &str) -> Option<DateTimeParts> {
    let c: Vec<char> = s.trim().chars().collect();
    let mut i = 0usize;
    let y = take_digits(&c, &mut i, 4, 4)? as i32;
    let sep = *c.get(i)?;
    if sep != '-' && sep != '/' {
        return None;
    }
    i += 1;
    let mo = take_digits(&c, &mut i, 1, 2)?;
    if c.get(i) != Some(&sep) {
        return None;
    }
    i += 1;
    let d = take_digits(&c, &mut i, 1, 2)?;
    let mut p = DateTimeParts {
        y,
        mo,
        d,
        h: 0,
        mi: 0,
        s: 0,
        frac: String::new(),
        has_time: false,
        tz: None,
    };
    if i < c.len()
        && (c[i] == 'T' || c[i] == ' ')
        && c.get(i + 1).map(|x| x.is_ascii_digit()) == Some(true)
    {
        i += 1;
        p.h = take_digits(&c, &mut i, 1, 2)?;
        if c.get(i) != Some(&':') {
            return None;
        }
        i += 1;
        p.mi = take_digits(&c, &mut i, 2, 2)?;
        if c.get(i) == Some(&':') {
            i += 1;
            p.s = take_digits(&c, &mut i, 2, 2)?;
            if c.get(i) == Some(&'.') || c.get(i) == Some(&',') {
                i += 1;
                let start = i;
                while i < c.len() && c[i].is_ascii_digit() && i - start < 9 {
                    i += 1;
                }
                p.frac = c[start..i].iter().collect();
            }
        }
        p.has_time = true;
        p.tz = take_tz(&c, &mut i)?;
    }
    if i != c.len() || !p.valid() {
        return None;
    }
    Some(p)
}

/// Date formats tried by "one-click fixes" for values that aren't ISO.
pub const DATE_CANDIDATES: &[&str] = &[
    "dd/MM/yyyy",
    "MM/dd/yyyy",
    "dd.MM.yyyy",
    "dd-MM-yyyy",
    "MM-dd-yyyy",
    "yyyy.MM.dd",
    "yyyyMMdd",
    "dd/MM/yyyy HH:mm:ss",
    "dd/MM/yyyy HH:mm",
    "MM/dd/yyyy HH:mm:ss",
    "MM/dd/yyyy HH:mm",
    "dd.MM.yyyy HH:mm:ss",
    "dd.MM.yyyy HH:mm",
    "dd/MM/yy",
    "MM/dd/yy",
];

/// The first candidate format that parses every value (None when none does).
pub fn suggest_date_format(values: &[&str]) -> Option<&'static str> {
    if values.is_empty() {
        return None;
    }
    for f in DATE_CANDIDATES {
        if let Some(fmt) = DateFormat::parse(f) {
            if values.iter().all(|v| parse_with(&fmt, v).is_some()) {
                return Some(f);
            }
        }
    }
    None
}

fn parse_date_value(fmt: Option<&DateFormat>, s: &str) -> Option<DateTimeParts> {
    if let Some(f) = fmt {
        if let Some(p) = parse_with(f, s) {
            return Some(p);
        }
    }
    parse_auto(s)
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Only NULLs so far.
    Empty,
    Bool,
    Int,
    BigInt,
    Decimal,
    Date,
    Timestamp,
    Json,
    Text,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Kind::Empty => "text",
            Kind::Bool => "bool",
            Kind::Int => "int",
            Kind::BigInt => "bigint",
            Kind::Decimal => "decimal",
            Kind::Date => "date",
            Kind::Timestamp => "timestamp",
            Kind::Json => "json",
            Kind::Text => "text",
        }
    }
}

fn is_bool_word(s: &str) -> Option<bool> {
    match s.to_ascii_lowercase().as_str() {
        "true" | "t" | "yes" | "y" => Some(true),
        "false" | "f" | "no" | "n" => Some(false),
        _ => None,
    }
}

/// Plain decimal number text: `-12`, `3.50`, `1e5`, `.5`. Returns (integer digits, scale, is integer).
fn number_shape(s: &str) -> Option<(usize, usize, bool)> {
    let b = s.as_bytes();
    if b.is_empty() {
        return None;
    }
    let mut i = 0;
    if b[0] == b'-' || b[0] == b'+' {
        i = 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut scale = 0;
    let mut is_int = true;
    if i < b.len() && b[i] == b'.' {
        is_int = false;
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        scale = i - fs;
    }
    if int_digits + scale == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        is_int = false;
        i += 1;
        if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
            i += 1;
        }
        let es = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == es {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    Some((int_digits, scale, is_int))
}

/// What one (non-NULL) value looks like.
pub fn classify_value(s: &str, date_fmt: Option<&DateFormat>) -> Kind {
    let t = s.trim();
    if t.is_empty() {
        return Kind::Text;
    }
    if let Some((digits, _, is_int)) = number_shape(t) {
        let unsigned = t.trim_start_matches(['-', '+']);
        // "007" / "0123": codes, not numbers.
        let leading_zero =
            unsigned.len() > 1 && unsigned.starts_with('0') && !unsigned.starts_with("0.");
        if !leading_zero {
            if is_int {
                return match t.parse::<i64>() {
                    Ok(v) if v >= i32::MIN as i64 && v <= i32::MAX as i64 => Kind::Int,
                    Ok(_) => Kind::BigInt,
                    Err(_) => Kind::Decimal,
                };
            }
            let _ = digits;
            return Kind::Decimal;
        }
        return Kind::Text;
    }
    if is_bool_word(t).is_some() && t.len() > 1 {
        return Kind::Bool;
    }
    if let Some(p) = parse_date_value(date_fmt, t) {
        return if p.has_time {
            Kind::Timestamp
        } else {
            Kind::Date
        };
    }
    if (t.starts_with('{') && t.ends_with('}')) || (t.starts_with('[') && t.ends_with(']')) {
        return Kind::Json;
    }
    Kind::Text
}

fn merge_kind(a: Kind, b: Kind) -> Kind {
    use Kind::*;
    if a == b {
        return a;
    }
    match (a, b) {
        (Empty, x) | (x, Empty) => x,
        (Int, BigInt) | (BigInt, Int) => BigInt,
        (Int, Decimal) | (Decimal, Int) | (BigInt, Decimal) | (Decimal, BigInt) => Decimal,
        (Date, Timestamp) | (Timestamp, Date) => Timestamp,
        _ => Text,
    }
}

/// Inferred column shape.
#[derive(Clone, Debug, PartialEq)]
pub struct Inferred {
    pub kind: Kind,
    pub max_len: usize,
    /// Decimal: total digits and digits after the point.
    pub precision: usize,
    pub scale: usize,
    pub nulls: usize,
    pub values: usize,
}

/// Accumulates value kinds per column.
pub struct Inferrer {
    cols: Vec<Inferred>,
    int_digits: Vec<usize>,
}

impl Inferrer {
    pub fn new(n: usize) -> Inferrer {
        Inferrer {
            cols: (0..n)
                .map(|_| Inferred {
                    kind: Kind::Empty,
                    max_len: 0,
                    precision: 0,
                    scale: 0,
                    nulls: 0,
                    values: 0,
                })
                .collect(),
            int_digits: vec![0; n],
        }
    }

    pub fn add(&mut self, row: &[Option<String>], date_fmt: Option<&DateFormat>) {
        for (i, v) in row.iter().enumerate() {
            if i >= self.cols.len() {
                break;
            }
            let c = &mut self.cols[i];
            match v {
                None => c.nulls += 1,
                Some(s) => {
                    c.values += 1;
                    let len = s.chars().count();
                    if len > c.max_len {
                        c.max_len = len;
                    }
                    let k = classify_value(s, date_fmt);
                    if matches!(k, Kind::Decimal | Kind::Int | Kind::BigInt) {
                        if let Some((d, sc, _)) = number_shape(s.trim()) {
                            if d > self.int_digits[i] {
                                self.int_digits[i] = d;
                            }
                            if sc > c.scale {
                                c.scale = sc;
                            }
                        }
                    }
                    c.kind = merge_kind(c.kind, k);
                }
            }
        }
    }

    pub fn result(&self) -> Vec<Inferred> {
        let mut out = self.cols.clone();
        for (i, c) in out.iter_mut().enumerate() {
            if c.kind == Kind::Decimal {
                let digits = self.int_digits[i].max(1) + c.scale;
                c.precision = digits.clamp(1, 38);
                if c.scale > 18 {
                    c.scale = 18;
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Value conversion for a target column
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetClass {
    Int,
    Decimal,
    Float,
    Bool,
    Date,
    Timestamp,
    TimestampTz,
    Json,
    Text,
}

/// Rough class of a column type name (any dialect).
pub fn classify_type(type_name: &str) -> TargetClass {
    let t = type_name.trim().to_ascii_lowercase();
    let base: String = t
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '_')
        .collect();
    let base = base.trim();
    if base == "tinyint(1)"
        || t.starts_with("tinyint(1)")
        || base == "bit"
        || base == "bool"
        || base == "boolean"
    {
        return TargetClass::Bool;
    }
    if base.starts_with("timestamp with time zone")
        || base == "timestamptz"
        || base == "datetimeoffset"
    {
        return TargetClass::TimestampTz;
    }
    if base.starts_with("timestamp")
        || base == "datetime"
        || base == "datetime2"
        || base == "smalldatetime"
    {
        return TargetClass::Timestamp;
    }
    if base == "date" {
        return TargetClass::Date;
    }
    if base == "json" || base == "jsonb" {
        return TargetClass::Json;
    }
    let first = base.split(' ').next().unwrap_or("");
    match first {
        "int" | "integer" | "bigint" | "smallint" | "tinyint" | "mediumint" | "int2" | "int4"
        | "int8" | "serial" | "bigserial" | "smallserial" => TargetClass::Int,
        "numeric" | "decimal" | "money" | "smallmoney" | "number" => TargetClass::Decimal,
        "real" | "float" | "float4" | "float8" | "double" => TargetClass::Float,
        _ => TargetClass::Text,
    }
}

/// Declared maximum length of char / varchar / nvarchar / nchar / character varying types.
pub fn type_max_len(type_name: &str) -> Option<usize> {
    let t = type_name.trim().to_ascii_lowercase();
    let is_char = t.starts_with("varchar")
        || t.starts_with("char")
        || t.starts_with("nvarchar")
        || t.starts_with("nchar")
        || t.starts_with("character varying")
        || t.starts_with("character(")
        || t.starts_with("bpchar");
    if !is_char {
        return None;
    }
    let open = t.find('(')?;
    let close = t[open..].find(')')? + open;
    t[open + 1..close]
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
}

/// A converted value, ready to bind.
#[derive(Clone, Debug, PartialEq)]
pub enum Bound {
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    Text(String),
}

/// Converts one source value for a column of `type_name`. `None` (NULL) stays NULL.
pub fn convert(
    dialect: Dialect,
    type_name: &str,
    raw: Option<&str>,
    date_fmt: Option<&DateFormat>,
) -> Result<Bound, String> {
    let s = match raw {
        None => return Ok(Bound::Null),
        Some(s) => s,
    };
    let class = classify_type(type_name);
    let t = s.trim();
    match class {
        TargetClass::Int => {
            let clean = t.strip_prefix('+').unwrap_or(t);
            match clean.parse::<i64>() {
                Ok(v) => Ok(Bound::Int(v)),
                Err(_) => {
                    // "12.0" is still a whole number.
                    if let Some((_, scale, _)) = number_shape(clean) {
                        if scale > 0
                            && clean.split('.').nth(1).map(|f| f.chars().all(|c| c == '0'))
                                == Some(true)
                        {
                            if let Ok(v) = clean.split('.').next().unwrap_or("").parse::<i64>() {
                                return Ok(Bound::Int(v));
                            }
                        }
                    }
                    Err(format!("“{}” isn’t a whole number", short(s)))
                }
            }
        }
        TargetClass::Decimal | TargetClass::Float => {
            if number_shape(t).is_none() {
                return Err(format!("“{}” isn’t a number", short(s)));
            }
            let clean = t.strip_prefix('+').unwrap_or(t).to_string();
            if dialect == Dialect::Sqlite {
                if let Ok(i) = clean.parse::<i64>() {
                    return Ok(Bound::Int(i));
                }
                if let Ok(f) = clean.parse::<f64>() {
                    return Ok(Bound::Float(f));
                }
            }
            Ok(Bound::Text(clean))
        }
        TargetClass::Bool => {
            let b = match t.to_ascii_lowercase().as_str() {
                "1" => Some(true),
                "0" => Some(false),
                other => is_bool_word(other),
            };
            match b {
                Some(v) => Ok(match dialect {
                    Dialect::Postgres => Bound::Text(if v { "true" } else { "false" }.into()),
                    Dialect::Mssql => Bound::Bool(v),
                    Dialect::Mysql | Dialect::Sqlite => Bound::Int(if v { 1 } else { 0 }),
                }),
                None => Err(format!("“{}” isn’t true / false", short(s))),
            }
        }
        TargetClass::Date => match parse_date_value(date_fmt, t) {
            Some(p) => Ok(Bound::Text(p.iso_date())),
            None => Err(format!(
                "“{}” isn’t a date{}",
                short(s),
                if date_fmt.is_some() {
                    " in the chosen format"
                } else {
                    " (YYYY-MM-DD)"
                }
            )),
        },
        TargetClass::Timestamp | TargetClass::TimestampTz => match parse_date_value(date_fmt, t) {
            Some(p) => {
                // MySQL DATETIME and SQL Server datetime2 take no zone; PostgreSQL timestamp ignores it.
                let keep = class == TargetClass::TimestampTz;
                let mut v = p.iso_timestamp(keep);
                if dialect == Dialect::Sqlite || (dialect == Dialect::Postgres && keep) {
                    v = p.iso_timestamp(true);
                }
                Ok(Bound::Text(v))
            }
            None => Err(format!(
                "“{}” isn’t a date / time{}",
                short(s),
                if date_fmt.is_some() {
                    " in the chosen format"
                } else {
                    " (YYYY-MM-DD HH:MM:SS)"
                }
            )),
        },
        TargetClass::Json | TargetClass::Text => {
            if let Some(n) = type_max_len(type_name) {
                let len = s.chars().count();
                if len > n {
                    return Err(format!(
                        "“{}” is too long for {} ({} characters)",
                        short(s),
                        type_name.trim(),
                        len
                    ));
                }
            }
            Ok(Bound::Text(s.to_string()))
        }
    }
}

fn short(s: &str) -> String {
    let t: String = s.chars().take(40).collect();
    if s.chars().count() > 40 {
        format!("{}…", t)
    } else {
        t
    }
}

/// NULL rules of the importer: an empty field is NULL; so is the "Treat as NULL" text when set.
pub fn null_rule(v: &str, null_text: &str) -> bool {
    v.is_empty() || (!null_text.is_empty() && v == null_text)
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

pub fn quote_ident(d: Dialect, name: &str) -> String {
    match d {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", name.replace(']', "]]")),
        Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub fn qualified(d: Dialect, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.trim().is_empty() => {
            format!("{}.{}", quote_ident(d, s), quote_ident(d, table))
        }
        _ => quote_ident(d, table),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Conflict {
    Fail,
    Skip,
    Update,
}

impl Conflict {
    pub fn parse(s: &str) -> Conflict {
        match s {
            "skip" => Conflict::Skip,
            "update" => Conflict::Update,
            _ => Conflict::Fail,
        }
    }
}

/// What one batched INSERT writes.
pub struct InsertSpec<'a> {
    pub dialect: Dialect,
    /// Qualified, quoted table name.
    pub table: &'a str,
    /// Target column names (unquoted).
    pub cols: &'a [String],
    /// Target column types (PostgreSQL casts).
    pub types: &'a [String],
    /// Key columns (unquoted) for skip / update.
    pub keys: &'a [String],
    pub conflict: Conflict,
}

/// Largest number of bound parameters per statement (a little under each server's limit).
pub fn param_limit(d: Dialect) -> usize {
    match d {
        Dialect::Postgres => 65_000,
        Dialect::Mysql => 65_000,
        Dialect::Mssql => 2_000,
        Dialect::Sqlite => 32_000,
    }
}

/// Rows per statement: the batch size within the parameter limit (SQL Server: also ≤ 1000 rows).
pub fn rows_per_statement(d: Dialect, ncols: usize, batch: usize) -> usize {
    let by_params = param_limit(d) / ncols.max(1);
    let mut n = batch.max(1).min(by_params.max(1));
    if d == Dialect::Mssql {
        n = n.min(1000);
    }
    n
}

fn safe_type(t: &str) -> Option<&str> {
    let t = t.trim();
    if t.is_empty() || t.contains(';') || t.contains("--") || t.contains("/*") {
        None
    } else {
        Some(t)
    }
}

/// The parameterized INSERT for `rows` rows (placeholders: `CAST($n AS type)` / `?` / `@Pn`).
pub fn insert_sql(spec: &InsertSpec, rows: usize) -> String {
    let d = spec.dialect;
    let qcols: Vec<String> = spec.cols.iter().map(|c| quote_ident(d, c)).collect();
    let ncols = spec.cols.len();
    let mut n = 0usize;
    let mut tuples: Vec<String> = Vec::with_capacity(rows);
    for _ in 0..rows {
        let mut ph: Vec<String> = Vec::with_capacity(ncols);
        for c in 0..ncols {
            n += 1;
            ph.push(match d {
                Dialect::Postgres => match spec.types.get(c).and_then(|t| safe_type(t)) {
                    Some(t) => format!("CAST(${} AS {})", n, t),
                    None => format!("${}", n),
                },
                Dialect::Mysql | Dialect::Sqlite => "?".to_string(),
                Dialect::Mssql => format!("@P{}", n),
            });
        }
        tuples.push(format!("({})", ph.join(", ")));
    }
    let values = tuples.join(", ");
    let keyset: Vec<&String> = spec.keys.iter().filter(|k| spec.cols.contains(k)).collect();
    let non_keys: Vec<&String> = spec
        .cols
        .iter()
        .filter(|c| !spec.keys.contains(c))
        .collect();
    let conflict = if keyset.is_empty() && spec.conflict == Conflict::Update {
        Conflict::Skip
    } else {
        spec.conflict
    };
    let cols = qcols.join(", ");
    match d {
        Dialect::Postgres | Dialect::Sqlite => {
            let ex = if d == Dialect::Postgres {
                "EXCLUDED"
            } else {
                "excluded"
            };
            let tail = match conflict {
                Conflict::Fail => String::new(),
                Conflict::Skip => " ON CONFLICT DO NOTHING".to_string(),
                Conflict::Update => {
                    let k: Vec<String> = keyset.iter().map(|c| quote_ident(d, c)).collect();
                    if non_keys.is_empty() {
                        format!(" ON CONFLICT ({}) DO NOTHING", k.join(", "))
                    } else {
                        let sets: Vec<String> = non_keys
                            .iter()
                            .map(|c| {
                                format!("{} = {}.{}", quote_ident(d, c), ex, quote_ident(d, c))
                            })
                            .collect();
                        format!(
                            " ON CONFLICT ({}) DO UPDATE SET {}",
                            k.join(", "),
                            sets.join(", ")
                        )
                    }
                }
            };
            format!(
                "INSERT INTO {} ({}) VALUES {}{}",
                spec.table, cols, values, tail
            )
        }
        Dialect::Mysql => match conflict {
            Conflict::Fail => format!("INSERT INTO {} ({}) VALUES {}", spec.table, cols, values),
            Conflict::Skip => format!(
                "INSERT IGNORE INTO {} ({}) VALUES {}",
                spec.table, cols, values
            ),
            Conflict::Update => {
                if non_keys.is_empty() {
                    format!(
                        "INSERT IGNORE INTO {} ({}) VALUES {}",
                        spec.table, cols, values
                    )
                } else {
                    let sets: Vec<String> = non_keys
                        .iter()
                        .map(|c| format!("{0} = VALUES({0})", quote_ident(d, c)))
                        .collect();
                    format!(
                        "INSERT INTO {} ({}) VALUES {} ON DUPLICATE KEY UPDATE {}",
                        spec.table,
                        cols,
                        values,
                        sets.join(", ")
                    )
                }
            }
        },
        Dialect::Mssql => {
            let src_cols = cols.clone();
            let on: Vec<String> = keyset
                .iter()
                .map(|k| format!("t.{0} = s.{0}", quote_ident(d, k)))
                .collect();
            match conflict {
                Conflict::Fail => {
                    format!("INSERT INTO {} ({}) VALUES {}", spec.table, cols, values)
                }
                Conflict::Skip => {
                    if on.is_empty() {
                        return format!("INSERT INTO {} ({}) VALUES {}", spec.table, cols, values);
                    }
                    let sel: Vec<String> = qcols.iter().map(|c| format!("s.{}", c)).collect();
                    format!(
                        "INSERT INTO {t} ({cols}) SELECT {sel} FROM (VALUES {values}) AS s ({src}) WHERE NOT EXISTS (SELECT 1 FROM {t} AS t WHERE {on})",
                        t = spec.table,
                        cols = cols,
                        sel = sel.join(", "),
                        values = values,
                        src = src_cols,
                        on = on.join(" AND ")
                    )
                }
                Conflict::Update => {
                    let ins: Vec<String> = qcols.iter().map(|c| format!("s.{}", c)).collect();
                    let upd = if non_keys.is_empty() {
                        String::new()
                    } else {
                        let sets: Vec<String> = non_keys
                            .iter()
                            .map(|c| format!("t.{0} = s.{0}", quote_ident(d, c)))
                            .collect();
                        format!(" WHEN MATCHED THEN UPDATE SET {}", sets.join(", "))
                    };
                    format!(
                        "MERGE INTO {t} AS t USING (VALUES {values}) AS s ({src}) ON {on}{upd} WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({ins});",
                        t = spec.table,
                        values = values,
                        src = src_cols,
                        on = on.join(" AND "),
                        upd = upd,
                        cols = cols,
                        ins = ins.join(", ")
                    )
                }
            }
        }
    }
}

/// Empties the table (SQLite has no TRUNCATE).
pub fn truncate_sql(d: Dialect, table: &str) -> String {
    match d {
        Dialect::Sqlite => format!("DELETE FROM {}", table),
        Dialect::Mssql => format!("TRUNCATE TABLE {}", table),
        _ => format!("TRUNCATE TABLE {}", table),
    }
}

pub fn savepoint_sql(d: Dialect) -> &'static str {
    match d {
        Dialect::Mssql => "SAVE TRANSACTION dt_import",
        _ => "SAVEPOINT dt_import",
    }
}

pub fn rollback_to_sql(d: Dialect) -> &'static str {
    match d {
        Dialect::Mssql => "ROLLBACK TRANSACTION dt_import",
        _ => "ROLLBACK TO SAVEPOINT dt_import",
    }
}

pub fn release_sql(d: Dialect) -> Option<&'static str> {
    match d {
        Dialect::Mssql => None,
        _ => Some("RELEASE SAVEPOINT dt_import"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(r: &[CsvRecord]) -> Vec<Vec<&str>> {
        r.iter()
            .map(|x| x.fields.iter().map(|s| s.as_str()).collect())
            .collect()
    }

    #[test]
    fn csv_basic_quotes_and_line_ends() {
        let t =
            "id,name,note\r\n1,\"Rossi, Marco\",\"say \"\"hi\"\"\"\r\n2,Ann,\"two\nlines\"\n\n3,,x";
        let r = parse_csv(t, ',', Some('"'));
        assert_eq!(
            fields(&r),
            vec![
                vec!["id", "name", "note"],
                vec!["1", "Rossi, Marco", "say \"hi\""],
                vec!["2", "Ann", "two\nlines"],
                vec!["3", "", "x"],
            ]
        );
        assert_eq!(
            r.iter().map(|x| x.line).collect::<Vec<_>>(),
            vec![1, 2, 3, 6]
        );
    }

    #[test]
    fn csv_streaming_matches_whole() {
        let t = "a;b\n\"x;y\";\"q\"\"q\"\r\nlast;row";
        let whole = parse_csv(t, ';', Some('"'));
        let mut p = CsvParser::new(';', Some('"'));
        let mut out = Vec::new();
        for ch in t.chars() {
            p.feed(&ch.to_string(), &mut out);
        }
        p.finish(&mut out);
        assert_eq!(whole, out);
        assert_eq!(fields(&out)[1], vec!["x;y", "q\"q"]);
    }

    #[test]
    fn csv_no_quote_and_unterminated() {
        let r = parse_csv("a\t\"b\n", '\t', None);
        assert_eq!(fields(&r), vec![vec!["a", "\"b"]]);
        let mut p = CsvParser::new(',', Some('"'));
        let mut out = Vec::new();
        p.feed("1,\"open\n2,3", &mut out);
        p.finish(&mut out);
        assert_eq!(p.unterminated, Some(1));
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn detects_delimiter_and_header() {
        assert_eq!(
            detect_delimiter("x.csv", "a;b;c\n1;2;3\n4;5;6\n", Some('"')),
            ';'
        );
        assert_eq!(detect_delimiter("x.txt", "a\tb\n1\t2\n", Some('"')), '\t');
        assert_eq!(
            detect_delimiter("x.csv", "a,b\n\"1,5\",2\n3,4\n", Some('"')),
            ','
        );
        assert_eq!(detect_delimiter("x.csv", "single\nvalue\n", Some('"')), ',');
        let rows = vec![
            vec!["id".to_string(), "email".into()],
            vec!["1".into(), "a@b".into()],
        ];
        assert!(detect_header(&rows));
        let rows = vec![vec!["1".to_string(), "a@b".into()]];
        assert!(!detect_header(&rows));
    }

    #[test]
    fn sniffs_kind() {
        assert_eq!(sniff_kind("a.json", " [ {}]"), SourceKind::JsonArray);
        assert_eq!(
            sniff_kind("a.json", "{\"a\":1}\n{\"a\":2}"),
            SourceKind::Ndjson
        );
        assert_eq!(sniff_kind("a.txt", "a,b"), SourceKind::Csv);
        assert_eq!(sniff_kind("a.jsonl", "{}"), SourceKind::Ndjson);
    }

    #[test]
    fn decodes_encodings() {
        let mut d = Decoder::new(Encoding::Utf8);
        let bytes = "\u{FEFF}é😀x".as_bytes();
        let mut s = String::new();
        for b in bytes {
            s.push_str(&d.feed(&[*b], false));
        }
        s.push_str(&d.feed(&[], true));
        assert_eq!(s, "é😀x");
        let mut d = Decoder::new(Encoding::Latin1);
        assert_eq!(d.feed(&[0x41, 0xE9, 0x80], true), "Aé€");
        let mut d = Decoder::new(Encoding::Utf16Le);
        let mut bytes = vec![0xFF, 0xFE];
        for u in "a😀".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let mut s = String::new();
        for b in &bytes {
            s.push_str(&d.feed(&[*b], false));
        }
        s.push_str(&d.feed(&[], true));
        assert_eq!(s, "a😀");
        assert_eq!(detect_encoding(&[0x61, 0xE9, 0x62]).0, Encoding::Latin1);
        assert_eq!(detect_encoding("é".as_bytes()).0, Encoding::Utf8);
        assert_eq!(
            detect_encoding(&[0x61, 0, 0x62, 0, 0x63, 0, 0x64, 0]).0,
            Encoding::Utf16Le
        );
        assert!(looks_like_mojibake("LÃ©a"));
        assert!(!looks_like_mojibake("Léa"));
    }

    #[test]
    fn splits_json_arrays() {
        let mut s = JsonArraySplitter::default();
        let mut out = Vec::new();
        let text = "[\n {\"a\": \"x,]\\\"y\"},\n {\"b\": [1, {\"c\": 2}]}, 3 ]";
        for ch in text.chars() {
            s.feed(&ch.to_string(), &mut out);
        }
        assert!(s.is_done());
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], (2, "{\"a\": \"x,]\\\"y\"}".to_string()));
        assert_eq!(out[1].1, "{\"b\": [1, {\"c\": 2}]}");
        assert_eq!(out[2].1, "3");
        let mut s = JsonArraySplitter::default();
        let mut out = Vec::new();
        s.feed("{\"a\":1}", &mut out);
        assert!(s.not_array);
    }

    #[test]
    fn dates() {
        let f = DateFormat::parse("dd/MM/yyyy").unwrap();
        assert_eq!(
            parse_with(&f, "13/11/2026").unwrap().iso_date(),
            "2026-11-13"
        );
        assert_eq!(parse_with(&f, "3/1/2026").unwrap().iso_date(), "2026-01-03");
        assert!(parse_with(&f, "31/02/2026").is_none());
        let f = DateFormat::parse("DD.MM.YYYY HH:mm").unwrap();
        assert_eq!(
            parse_with(&f, "01.12.2026 09:05")
                .unwrap()
                .iso_timestamp(false),
            "2026-12-01 09:05:00"
        );
        let f = DateFormat::parse("dd/mm/yyyy").unwrap();
        assert_eq!(
            parse_with(&f, "05/06/2026").unwrap().iso_date(),
            "2026-06-05"
        );
        let f = DateFormat::parse("yyyyMMdd").unwrap();
        assert_eq!(parse_with(&f, "20261127").unwrap().iso_date(), "2026-11-27");
        let p = parse_auto("2026-11-27T08:12:00.5Z").unwrap();
        assert_eq!(p.iso_timestamp(true), "2026-11-27 08:12:00.5+00:00");
        assert_eq!(parse_auto("2026-11-27").unwrap().iso_date(), "2026-11-27");
        assert!(parse_auto("27/11/2026").is_none());
        assert_eq!(
            parse_auto("2026-11-27 10:00:00+0130")
                .unwrap()
                .tz
                .as_deref(),
            Some("+01:30")
        );
        assert_eq!(
            suggest_date_format(&["13/11/2026", "14/11/2026"]),
            Some("dd/MM/yyyy")
        );
        assert_eq!(suggest_date_format(&["11/13/2026"]), Some("MM/dd/yyyy"));
        assert_eq!(suggest_date_format(&["nope"]), None);
    }

    #[test]
    fn infers_kinds() {
        let mut inf = Inferrer::new(6);
        let rows = vec![
            vec![
                Some("1"),
                Some("1.50"),
                Some("2026-01-02"),
                Some("yes"),
                Some("007"),
                Some("3000000000"),
            ],
            vec![
                Some("2"),
                Some("12"),
                Some("2026-01-02 10:00"),
                None,
                Some("12"),
                Some("4"),
            ],
        ];
        for r in rows {
            let r: Vec<Option<String>> = r.into_iter().map(|v| v.map(String::from)).collect();
            inf.add(&r, None);
        }
        let k: Vec<Kind> = inf.result().iter().map(|c| c.kind).collect();
        assert_eq!(
            k,
            vec![
                Kind::Int,
                Kind::Decimal,
                Kind::Timestamp,
                Kind::Bool,
                Kind::Text,
                Kind::BigInt
            ]
        );
        let r = inf.result();
        assert_eq!((r[1].precision, r[1].scale), (4, 2));
        assert_eq!(r[3].nulls, 1);
    }

    #[test]
    fn converts_values() {
        let f = DateFormat::parse("dd/MM/yyyy").unwrap();
        assert_eq!(
            convert(Dialect::Postgres, "bigint", Some(" 42 "), None),
            Ok(Bound::Int(42))
        );
        assert_eq!(
            convert(Dialect::Postgres, "integer", Some("12.0"), None),
            Ok(Bound::Int(12))
        );
        assert!(convert(Dialect::Postgres, "integer", Some("n/a"), None)
            .unwrap_err()
            .contains("whole number"));
        assert_eq!(
            convert(Dialect::Postgres, "numeric(12,2)", Some("1204.50"), None),
            Ok(Bound::Text("1204.50".into()))
        );
        assert_eq!(
            convert(Dialect::Sqlite, "NUMERIC", Some("1.5"), None),
            Ok(Bound::Float(1.5))
        );
        assert_eq!(
            convert(Dialect::Mysql, "tinyint(1)", Some("true"), None),
            Ok(Bound::Int(1))
        );
        assert_eq!(
            convert(Dialect::Mssql, "bit", Some("no"), None),
            Ok(Bound::Bool(false))
        );
        assert_eq!(
            convert(Dialect::Postgres, "date", Some("13/11/2026"), Some(&f)),
            Ok(Bound::Text("2026-11-13".into()))
        );
        assert!(convert(Dialect::Postgres, "date", Some("13/11/2026"), None).is_err());
        assert_eq!(
            convert(
                Dialect::Postgres,
                "timestamp with time zone",
                Some("2026-11-27T08:12:00Z"),
                None
            ),
            Ok(Bound::Text("2026-11-27 08:12:00+00:00".into()))
        );
        assert_eq!(
            convert(
                Dialect::Mysql,
                "datetime(6)",
                Some("2026-11-27T08:12:00Z"),
                None
            ),
            Ok(Bound::Text("2026-11-27 08:12:00".into()))
        );
        assert!(
            convert(Dialect::Postgres, "character(2)", Some("ITA"), None)
                .unwrap_err()
                .contains("too long")
        );
        assert_eq!(
            convert(Dialect::Postgres, "text", None, None),
            Ok(Bound::Null)
        );
        assert!(null_rule("", "n/a") && null_rule("n/a", "n/a") && !null_rule("x", ""));
        assert_eq!(type_max_len("character varying(255)"), Some(255));
        assert_eq!(type_max_len("nvarchar(max)"), None);
        assert_eq!(
            classify_type("timestamp without time zone"),
            TargetClass::Timestamp
        );
        assert_eq!(classify_type("double precision"), TargetClass::Float);
    }

    #[test]
    fn builds_inserts() {
        let cols = vec!["id".to_string(), "name".to_string()];
        let types = vec!["bigint".to_string(), "text".to_string()];
        let keys = vec!["id".to_string()];
        let mut spec = InsertSpec {
            dialect: Dialect::Postgres,
            table: "\"public\".\"t\"",
            cols: &cols,
            types: &types,
            keys: &keys,
            conflict: Conflict::Update,
        };
        assert_eq!(
            insert_sql(&spec, 2),
            "INSERT INTO \"public\".\"t\" (\"id\", \"name\") VALUES (CAST($1 AS bigint), CAST($2 AS text)), (CAST($3 AS bigint), CAST($4 AS text)) ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\""
        );
        spec.conflict = Conflict::Skip;
        spec.dialect = Dialect::Sqlite;
        spec.table = "\"t\"";
        assert_eq!(
            insert_sql(&spec, 1),
            "INSERT INTO \"t\" (\"id\", \"name\") VALUES (?, ?) ON CONFLICT DO NOTHING"
        );
        spec.dialect = Dialect::Mysql;
        spec.table = "`t`";
        assert_eq!(
            insert_sql(&spec, 1),
            "INSERT IGNORE INTO `t` (`id`, `name`) VALUES (?, ?)"
        );
        spec.conflict = Conflict::Update;
        assert_eq!(
            insert_sql(&spec, 1),
            "INSERT INTO `t` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)"
        );
        spec.dialect = Dialect::Mssql;
        spec.table = "[dbo].[t]";
        spec.conflict = Conflict::Skip;
        assert_eq!(
            insert_sql(&spec, 2),
            "INSERT INTO [dbo].[t] ([id], [name]) SELECT s.[id], s.[name] FROM (VALUES (@P1, @P2), (@P3, @P4)) AS s ([id], [name]) WHERE NOT EXISTS (SELECT 1 FROM [dbo].[t] AS t WHERE t.[id] = s.[id])"
        );
        spec.conflict = Conflict::Update;
        assert_eq!(
            insert_sql(&spec, 1),
            "MERGE INTO [dbo].[t] AS t USING (VALUES (@P1, @P2)) AS s ([id], [name]) ON t.[id] = s.[id] WHEN MATCHED THEN UPDATE SET t.[name] = s.[name] WHEN NOT MATCHED THEN INSERT ([id], [name]) VALUES (s.[id], s.[name]);"
        );
        assert_eq!(rows_per_statement(Dialect::Mssql, 6, 1000), 333);
        assert_eq!(rows_per_statement(Dialect::Postgres, 6, 1000), 1000);
        assert_eq!(rows_per_statement(Dialect::Mssql, 1, 5000), 1000);
        assert_eq!(
            unique_names(&["a".into(), "".into(), "A".into()]),
            vec!["a", "column2", "A_2"]
        );
    }
}

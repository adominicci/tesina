use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const INPUT_BYTES: usize = 96 * 1024;
pub const OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    UnsupportedPlatform,
    UnsupportedHardware,
    SidecarAbsent,
    NotInstalled,
    Busy,
    Cancelled,
    InvalidRequest,
    InvalidResponse,
    StartupFailed,
    Timeout,
    OutOfMemory,
    Crash,
    ShuttingDown,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Task {
    WritingCoach,
    GroundedQuiz,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Passage {
    pub source_id: String,
    pub snapshot_id: String,
    pub text: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Es,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CoachInput {
    pub document_language: Language,
    pub passage: Passage,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QuizInput {
    pub document_language: Language,
    pub sources: Vec<Passage>,
    pub question_count: u8,
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum Input {
    Coach(CoachInput),
    Quiz(QuizInput),
}
#[derive(Clone, Serialize)]
#[serde(untagged, rename_all = "camelCase")]
pub enum Identity {
    Revision {
        #[serde(rename = "documentRevision")]
        document_revision: u64,
    },
    Snapshot {
        #[serde(rename = "sourceSnapshotId")]
        source_snapshot_id: String,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Correlation {
    pub request_id: String,
    pub task: Task,
    #[serde(flatten)]
    pub identity: Identity,
}
// No Debug: request, draft, path and token contents never enter diagnostics.
pub struct Request {
    pub correlation: Correlation,
    pub input: Result<Input, ErrorCode>,
    bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Envelope {
    request_id: String,
    task: Task,
    document_revision: Option<u64>,
    source_snapshot_id: Option<String>,
    input: Value,
}
pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && uuid::Uuid::parse_str(value)
            .is_ok_and(|id| id.hyphenated().to_string().eq_ignore_ascii_case(value))
}
pub fn admit(value: Value) -> Result<Request, ErrorCode> {
    if value.get("documentRevision").is_some() == value.get("sourceSnapshotId").is_some() {
        return Err(ErrorCode::InvalidRequest);
    }
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| ErrorCode::InvalidRequest)?
        .len();
    let raw: Envelope = serde_json::from_value(value).map_err(|_| ErrorCode::InvalidRequest)?;
    if !valid_uuid(&raw.request_id) {
        return Err(ErrorCode::InvalidRequest);
    }
    let identity = match (raw.document_revision, raw.source_snapshot_id) {
        (Some(document_revision), None) if document_revision <= 9_007_199_254_740_991 => {
            Identity::Revision { document_revision }
        }
        (None, Some(source_snapshot_id)) if identifier(&source_snapshot_id) => {
            Identity::Snapshot { source_snapshot_id }
        }
        _ => return Err(ErrorCode::InvalidRequest),
    };
    let input = match raw.task {
        Task::WritingCoach => serde_json::from_value(raw.input).map(Input::Coach),
        Task::GroundedQuiz => serde_json::from_value(raw.input).map(Input::Quiz),
    }
    .map_err(|_| ErrorCode::InvalidRequest);
    Ok(Request {
        correlation: Correlation {
            request_id: raw.request_id,
            task: raw.task,
            identity,
        },
        input,
        bytes,
    })
}
impl Correlation {
    pub fn error(&self, code: ErrorCode) -> Value {
        let mut result = serde_json::to_value(self).expect("closed correlation serializes");
        result["status"] = json!("error");
        result["error"] = json!(code);
        result
    }
    pub fn success(&self, output: Value) -> Value {
        let mut result = serde_json::to_value(self).expect("closed correlation serializes");
        result["status"] = json!("ok");
        result["output"] = output;
        result
    }
}
impl Request {
    pub fn sources(&self) -> Vec<&Passage> {
        match &self.input {
            Ok(Input::Coach(input)) => vec![&input.passage],
            Ok(Input::Quiz(input)) => input.sources.iter().collect(),
            Err(_) => Vec::new(),
        }
    }
    pub fn validate(&self) -> Result<(), ErrorCode> {
        let input = self.input.as_ref().map_err(|code| *code)?;
        if self.bytes > INPUT_BYTES {
            return Err(ErrorCode::InvalidRequest);
        }
        if let Input::Quiz(quiz) = input {
            if !matches!(quiz.question_count, 5 | 10) {
                return Err(ErrorCode::InvalidRequest);
            }
        }
        let sources = self.sources();
        if sources.is_empty() || sources.len() > 4 {
            return Err(ErrorCode::InvalidRequest);
        }
        let mut identities = HashSet::new();
        let mut units = 0;
        for source in sources {
            units += source.text.encode_utf16().count();
            if source.text.is_empty()
                || units > 16_384
                || !identifier(&source.source_id)
                || !identifier(&source.snapshot_id)
                || !identities.insert((&source.source_id, &source.snapshot_id))
            {
                return Err(ErrorCode::InvalidRequest);
            }
            if let Identity::Snapshot { source_snapshot_id } = &self.correlation.identity {
                if source_snapshot_id != &source.snapshot_id {
                    return Err(ErrorCode::InvalidRequest);
                }
            }
        }
        Ok(())
    }
}

pub fn valid_range(text: &str, from: u64, to: u64) -> bool {
    if from >= to {
        return false;
    }
    let mut units = 0;
    let mut start = from == 0;
    let mut end = false;
    for ch in text.chars() {
        units += ch.len_utf16() as u64;
        start |= units == from;
        end |= units == to;
    }
    start && end && to <= units
}

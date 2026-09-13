use super::contract::{valid_range, ErrorCode, Input, Request, OUTPUT_BYTES};
use serde::de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};
use std::fmt;

// This visitor sees every key before any object can collapse duplicates.
struct Json(u8);
impl<'de> DeserializeSeed<'de> for Json {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, de: D) -> Result<Value, D::Error> {
        de.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Json {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: Error>(self, v: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("invalid-response"))
    }
    fn visit_str<E: Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        if self.0 >= 32 {
            return Err(A::Error::custom("invalid-response"));
        }
        let mut values = Vec::new();
        while let Some(v) = a.next_element_seed(Json(self.0 + 1))? {
            values.push(v);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        if self.0 >= 32 {
            return Err(A::Error::custom("invalid-response"));
        }
        let mut values = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(A::Error::custom("invalid-response"));
            }
            values.insert(key, a.next_value_seed(Json(self.0 + 1))?);
        }
        Ok(Value::Object(values))
    }
}
pub fn parse(bytes: &[u8]) -> Result<Value, ErrorCode> {
    if bytes.len() > OUTPUT_BYTES {
        return Err(ErrorCode::InvalidResponse);
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = Json(0)
        .deserialize(&mut deserializer)
        .map_err(|_| ErrorCode::InvalidResponse)?;
    deserializer.end().map_err(|_| ErrorCode::InvalidResponse)?;
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Category {
    Specificity,
    Evidence,
    Clarity,
    Economy,
    Repetition,
    Voice,
}
#[derive(Deserialize)]
enum LocalSource {
    #[serde(rename = "local-model")]
    Model,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Issue {
    from: u64,
    to: u64,
    #[serde(rename = "category")]
    _category: Category,
    explanation: String,
    learning_question: String,
    #[serde(rename = "source")]
    _source: LocalSource,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CoachDraft {
    issues: Vec<Issue>,
}
#[derive(Deserialize)]
enum Unit {
    #[serde(rename = "utf16")]
    Utf16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Span {
    source_id: String,
    snapshot_id: String,
    from: u64,
    to: u64,
    #[serde(rename = "unit")]
    _unit: Unit,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Provenance {
    question: Vec<Span>,
    options: [Vec<Span>; 4],
    explanation: Vec<Span>,
    distractor_explanations: [Vec<Span>; 4],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Question {
    question: String,
    options: [String; 4],
    correct_index: u8,
    explanation: String,
    distractor_explanations: [String; 4],
    provenance: Provenance,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuizDraft {
    questions: Vec<Question>,
}
fn bounded(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 2048
}
fn spans(spans: &[Span], request: &Request) -> bool {
    if spans.is_empty() || spans.len() > 4 {
        return false;
    }
    let sources = request.sources();
    let mut previous: Option<(usize, u64)> = None;
    for span in spans {
        let Some(index) = sources
            .iter()
            .position(|s| s.source_id == span.source_id && s.snapshot_id == span.snapshot_id)
        else {
            return false;
        };
        if !valid_range(&sources[index].text, span.from, span.to) {
            return false;
        }
        if previous.is_some_and(|(i, end)| index < i || (index == i && span.from < end)) {
            return false;
        }
        previous = Some((index, span.to));
    }
    true
}
pub fn validate_draft(bytes: &[u8], request: &Request) -> Result<Value, ErrorCode> {
    let value = parse(bytes)?;
    match request
        .input
        .as_ref()
        .map_err(|_| ErrorCode::InvalidResponse)?
    {
        Input::Coach(input) => {
            let draft: CoachDraft =
                serde_json::from_value(value.clone()).map_err(|_| ErrorCode::InvalidResponse)?;
            if draft.issues.len() > 32
                || draft.issues.iter().any(|issue| {
                    !valid_range(&input.passage.text, issue.from, issue.to)
                        || !bounded(&issue.explanation)
                        || !bounded(&issue.learning_question)
                })
            {
                return Err(ErrorCode::InvalidResponse);
            }
        }
        Input::Quiz(input) => {
            let draft: QuizDraft =
                serde_json::from_value(value.clone()).map_err(|_| ErrorCode::InvalidResponse)?;
            if draft.questions.len() != usize::from(input.question_count) {
                return Err(ErrorCode::InvalidResponse);
            }
            for q in draft.questions {
                if q.correct_index > 3
                    || !bounded(&q.question)
                    || !bounded(&q.explanation)
                    || q.options
                        .iter()
                        .chain(&q.distractor_explanations)
                        .any(|s| !bounded(s))
                    || !spans(&q.provenance.question, request)
                    || !spans(&q.provenance.explanation, request)
                    || q.provenance
                        .options
                        .iter()
                        .chain(&q.provenance.distractor_explanations)
                        .any(|s| !spans(s, request))
                {
                    return Err(ErrorCode::InvalidResponse);
                }
            }
        }
    }
    Ok(value)
}

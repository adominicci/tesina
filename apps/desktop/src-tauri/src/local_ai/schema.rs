use super::contract::Input;
use serde_json::{json, Value};

fn closed(properties: Value) -> Value {
    let required: Vec<_> = properties
        .as_object()
        .expect("native schema properties")
        .keys()
        .cloned()
        .collect();
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn array(items: Value, min: usize, max: usize) -> Value {
    json!({"type":"array","items":items,"minItems":min,"maxItems":max})
}
fn offset(min: usize, max: usize) -> Value {
    json!({"type":"integer","minimum":min,"maximum":max})
}

// The grammar describes the complete draft shape. The independent response
// validator still enforces UTF-16 boundaries, source order and semantic limits.
pub(super) fn draft(input: &Input) -> Value {
    let text = json!({"type":"string","minLength":1,"maxLength":2048});
    match input {
        Input::Coach(input) => {
            let units = input.passage.text.encode_utf16().count();
            let issue = closed(json!({
                "from":offset(0, units - 1), "to":offset(1, units),
                "category":{"type":"string","enum":["specificity","evidence","clarity","economy","repetition","voice"]},
                "explanation":text,"learningQuestion":text,"source":{"const":"local-model"}
            }));
            closed(json!({"issues":array(issue, 0, 32)}))
        }
        Input::Quiz(input) => {
            let choices: Vec<_> = input.sources.iter().map(|source| {
                let units = source.text.encode_utf16().count();
                closed(json!({"sourceId":{"const":source.source_id},"snapshotId":{"const":source.snapshot_id},
                    "from":offset(0, units - 1),"to":offset(1, units),"unit":{"const":"utf16"}}))
            }).collect();
            let spans = array(json!({"anyOf":choices}), 1, 4);
            let provenance = closed(json!({"question":spans,"explanation":spans,
                "options":array(spans.clone(), 4, 4),"distractorExplanations":array(spans.clone(), 4, 4)}));
            let question = closed(json!({"question":text,"explanation":text,
                "options":array(text.clone(), 4, 4),"distractorExplanations":array(text, 4, 4),
                "correctIndex":offset(0, 3),"provenance":provenance}));
            let count = usize::from(input.question_count);
            closed(json!({"questions":array(question, count, count)}))
        }
    }
}

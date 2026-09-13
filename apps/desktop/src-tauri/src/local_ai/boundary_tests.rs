use super::{
    contract::{admit, ErrorCode},
    response, Service,
};
use serde_json::{json, Value};

fn coach() -> Value {
    json!({"requestId":"f98b4102-986b-4abc-9bb4-b760f7b136b7","documentRevision":7,"task":"writingCoach","input":{"documentLanguage":"es","passage":{"sourceId":"p","snapshotId":"s","text":"Árbol 🌱 e\u{301}"}}})
}

#[test]
fn input_utf16_and_escaped_utf8_budgets_are_independent_and_inclusive() {
    let mut request = coach();
    request["documentRevision"] = json!(9_007_199_254_740_991u64);
    request["input"]["passage"]["sourceId"] = json!("P_0-".repeat(16));
    request["input"]["passage"]["snapshotId"] = json!("s".repeat(64));
    request["input"]["passage"]["text"] = json!("🌱".repeat(8192));
    assert!(admit(request.clone()).unwrap().validate().is_ok());
    request["input"]["passage"]["text"] = json!(format!("{}a", "🌱".repeat(8192)));
    assert_eq!(
        admit(request).unwrap().validate(),
        Err(ErrorCode::InvalidRequest)
    );

    let mut request = coach();
    request["input"]["passage"]["text"] = json!("");
    let space = 98_304 - serde_json::to_vec(&request).unwrap().len();
    let text = format!("{}{}", "\0".repeat(space / 6), "x".repeat(space % 6));
    assert!(text.encode_utf16().count() < 16_384);
    request["input"]["passage"]["text"] = json!(text);
    assert_eq!(serde_json::to_vec(&request).unwrap().len(), 98_304);
    assert!(admit(request.clone()).unwrap().validate().is_ok());
    request["input"]["passage"]["text"] = json!(format!(
        "{}x",
        request["input"]["passage"]["text"].as_str().unwrap()
    ));
    assert_eq!(serde_json::to_vec(&request).unwrap().len(), 98_305);
    assert_eq!(
        admit(request).unwrap().validate(),
        Err(ErrorCode::InvalidRequest)
    );
}

#[test]
fn parser_rejects_recursive_duplicate_keys_extra_values_and_exact_depth_byte_overruns() {
    let depth32 = format!("{}0{}", "[".repeat(32), "]".repeat(32));
    assert!(response::parse(depth32.as_bytes()).is_ok());
    let depth33 = format!("[{depth32}]");
    for malformed in [
        depth33.as_str(),
        r#"{"x":{"a":1,"\u0061":2}}"#,
        r#"[{"x":0,"x":1}]"#,
        "{} {}",
        "null false",
        "{}junk",
        "NaN",
        "1e999",
        "\"\\ud800\"",
    ] {
        assert_eq!(
            response::parse(malformed.as_bytes()),
            Err(ErrorCode::InvalidResponse)
        );
    }
    assert_eq!(response::parse(b" \n {}\r\t "), Ok(json!({})));
    let exact = format!("\"{}\"", "a".repeat(262_142));
    assert_eq!(exact.len(), 262_144);
    assert!(response::parse(exact.as_bytes()).is_ok());
    assert_eq!(
        response::parse(format!("{exact} ").as_bytes()),
        Err(ErrorCode::InvalidResponse)
    );
    assert_eq!(
        response::parse(&[b'"', 0xff, b'"']),
        Err(ErrorCode::InvalidResponse)
    );
}

fn quiz(count: u8) -> Value {
    json!({"requestId":"f98b4102-986b-4abc-9bb4-b760f7b136b7","sourceSnapshotId":"s","task":"groundedQuiz","input":{"documentLanguage":"en","sources":[{"sourceId":"p","snapshotId":"s","text":"🌱 e\u{301} abcd"},{"sourceId":"q","snapshotId":"s","text":"Otra fuente"}],"questionCount":count}})
}

#[test]
fn quiz_admission_enforces_joint_source_budget_names_and_requested_counts() {
    for count in [5, 10] {
        for language in ["en", "es"] {
            let mut request = quiz(count);
            request["input"]["documentLanguage"] = json!(language);
            request["input"]["sources"] = json!((0..4).map(|i| json!({"sourceId":format!("p{i}"),"snapshotId":"s","text":"🌱".repeat(2048)})).collect::<Vec<_>>());
            assert!(admit(request.clone()).unwrap().validate().is_ok());
            request["input"]["sources"][3]["text"] = json!(format!("{}x", "🌱".repeat(2048)));
            assert_eq!(
                admit(request).unwrap().validate(),
                Err(ErrorCode::InvalidRequest)
            );
        }
    }
    let valid = quiz(5);
    for (field, bad) in [
        ("questionCount", json!(4)),
        ("questionCount", json!(6)),
        ("questionCount", json!(11)),
        ("questionCount", json!(5.5)),
        ("documentLanguage", json!("EN")),
        ("sources", json!([])),
        (
            "sources",
            json!(vec![valid["input"]["sources"][0].clone(); 2]),
        ),
        (
            "sources",
            json!((0..5)
                .map(|i| json!({"sourceId":format!("p{i}"),"snapshotId":"s","text":"x"}))
                .collect::<Vec<_>>()),
        ),
    ] {
        let mut request = valid.clone();
        request["input"][field] = bad;
        assert_eq!(
            admit(request).unwrap().validate(),
            Err(ErrorCode::InvalidRequest)
        );
    }
    for (field, bad) in [
        ("sourceId", ""),
        ("sourceId", "bad/path"),
        ("snapshotId", "foreign"),
    ] {
        let mut request = valid.clone();
        request["input"]["sources"][1][field] = json!(bad);
        assert_eq!(
            admit(request).unwrap().validate(),
            Err(ErrorCode::InvalidRequest)
        );
    }
}

fn question() -> Value {
    let spans = json!([
        {"sourceId":"p","snapshotId":"s","from":0,"to":2,"unit":"utf16"},
        {"sourceId":"p","snapshotId":"s","from":3,"to":5,"unit":"utf16"},
        {"sourceId":"p","snapshotId":"s","from":6,"to":7,"unit":"utf16"},
        {"sourceId":"q","snapshotId":"s","from":0,"to":1,"unit":"utf16"}
    ]);
    json!({"question":"¿🌱?","options":["A","B","C","D"],"correctIndex":3,"explanation":"e\u{301}","distractorExplanations":["a","b","c","d"],"provenance":{"question":spans,"options":[spans,spans,spans,spans],"explanation":spans,"distractorExplanations":[spans,spans,spans,spans]}})
}

#[test]
fn quiz_drafts_reject_the_whole_result_for_wrong_tuples_fields_strings_or_provenance() {
    for count in [5, 10] {
        let request = admit(quiz(count)).unwrap();
        let valid = json!({"questions":vec![question(); count as usize]});
        assert_eq!(
            response::validate_draft(&serde_json::to_vec(&valid).unwrap(), &request),
            Ok(valid.clone())
        );
        for questions in [count - 1, count + 1] {
            let wrong = json!({"questions":vec![question(); questions as usize]});
            assert_eq!(
                response::validate_draft(&serde_json::to_vec(&wrong).unwrap(), &request),
                Err(ErrorCode::InvalidResponse)
            );
        }
    }
    let request = admit(quiz(5)).unwrap();
    let valid = json!({"questions":vec![question(); 5]});
    for (pointer, bad) in [
        ("/questions/4/options", json!(["A", "B", "C"])),
        (
            "/questions/4/distractorExplanations",
            json!(["a", "b", "c", "d", "e"]),
        ),
        ("/questions/4/correctIndex", json!(4)),
        ("/questions/4/correctIndex", json!(1.5)),
        ("/questions/4/question", json!("")),
        ("/questions/4/explanation", json!("🌱".repeat(1025))),
        ("/questions/4/provenance/question", json!([])),
        ("/questions/4/provenance/options", json!([])),
        ("/questions/4/provenance/question/0/from", json!(1)),
        ("/questions/4/provenance/question/0/to", json!(1)),
        (
            "/questions/4/provenance/question/0/sourceId",
            json!("foreign"),
        ),
        (
            "/questions/4/provenance/question/0/snapshotId",
            json!("foreign"),
        ),
        ("/questions/4/provenance/question/0/unit", json!("bytes")),
        ("/questions/4/provenance/question/1/from", json!(0)),
    ] {
        let mut bad_draft = valid.clone();
        *bad_draft.pointer_mut(pointer).unwrap() = bad;
        assert_eq!(
            response::validate_draft(&serde_json::to_vec(&bad_draft).unwrap(), &request),
            Err(ErrorCode::InvalidResponse),
            "invalid last question must not yield four partial questions: {pointer}"
        );
    }
    let mut draft = valid.clone();
    draft["questions"][4]["provenance"]["question"]
        .as_array_mut()
        .unwrap()
        .push(json!({"sourceId":"q","snapshotId":"s","from":1,"to":2,"unit":"utf16"}));
    assert_eq!(
        response::validate_draft(&serde_json::to_vec(&draft).unwrap(), &request),
        Err(ErrorCode::InvalidResponse)
    );
    let mut draft = valid.clone();
    draft["questions"][4]["extra"] = json!("CANARY");
    assert_eq!(
        response::validate_draft(&serde_json::to_vec(&draft).unwrap(), &request),
        Err(ErrorCode::InvalidResponse)
    );
    let mut draft = valid;
    draft["questions"][4]["explanation"] = json!("🌱".repeat(1024));
    let mut bytes = serde_json::to_vec(&draft).unwrap();
    bytes.resize(262_144, b' ');
    assert!(response::validate_draft(&bytes, &request).is_ok());
    bytes.push(b' ');
    assert_eq!(
        response::validate_draft(&bytes, &request),
        Err(ErrorCode::InvalidResponse)
    );
}

#[test]
fn coach_drafts_bound_joint_bytes_issue_count_and_each_utf16_string() {
    let request = admit(coach()).unwrap();
    let issue = json!({"from":6,"to":8,"category":"clarity","explanation":"Á","learningQuestion":"¿🌱?","source":"local-model"});
    for category in [
        "specificity",
        "evidence",
        "clarity",
        "economy",
        "repetition",
        "voice",
    ] {
        let mut one = issue.clone();
        one["category"] = json!(category);
        assert!(response::validate_draft(
            &serde_json::to_vec(&json!({"issues":[one]})).unwrap(),
            &request
        )
        .is_ok());
    }
    assert!(response::validate_draft(
        &serde_json::to_vec(&json!({"issues":vec![issue.clone();32]})).unwrap(),
        &request
    )
    .is_ok());
    assert_eq!(
        response::validate_draft(
            &serde_json::to_vec(&json!({"issues":vec![issue.clone();33]})).unwrap(),
            &request
        ),
        Err(ErrorCode::InvalidResponse)
    );
    for field in ["explanation", "learningQuestion"] {
        let mut one = issue.clone();
        one[field] = json!("🌱".repeat(1024));
        assert!(response::validate_draft(
            &serde_json::to_vec(&json!({"issues":[one.clone()]})).unwrap(),
            &request
        )
        .is_ok());
        one[field] = json!(format!("{}x", "🌱".repeat(1024)));
        assert_eq!(
            response::validate_draft(
                &serde_json::to_vec(&json!({"issues":[issue.clone(),one]})).unwrap(),
                &request
            ),
            Err(ErrorCode::InvalidResponse)
        );
    }
    let mut large = issue;
    large["explanation"] = json!("🌱".repeat(1024));
    large["learningQuestion"] = json!("🌱".repeat(1024));
    let bytes = serde_json::to_vec(&json!({"issues":vec![large;32]})).unwrap();
    assert!(bytes.len() > 262_144);
    assert_eq!(
        response::validate_draft(&bytes, &request),
        Err(ErrorCode::InvalidResponse)
    );
}

#[tokio::test]
async fn capability_floors_and_missing_prerequisites_stay_dormant_and_ordered() {
    use super::capability::{evaluate, installed_model};
    for (os, arch, version, sidecar, model, expected) in [
        (
            "linux",
            "x86_64",
            (99, 0),
            false,
            false,
            Err(ErrorCode::UnsupportedPlatform),
        ),
        (
            "macos",
            "aarch64",
            (13, 2),
            false,
            false,
            Err(ErrorCode::UnsupportedHardware),
        ),
        (
            "macos",
            "x86_64",
            (13, 3),
            false,
            false,
            Err(ErrorCode::SidecarAbsent),
        ),
        (
            "macos",
            "aarch64",
            (13, 3),
            true,
            false,
            Err(ErrorCode::NotInstalled),
        ),
        (
            "windows",
            "x86_64",
            (9, 9),
            true,
            true,
            Err(ErrorCode::UnsupportedHardware),
        ),
        (
            "windows",
            "aarch64",
            (10, 0),
            true,
            true,
            Err(ErrorCode::UnsupportedHardware),
        ),
        ("windows", "x86_64", (10, 0), true, true, Ok("busy")),
    ] {
        assert_eq!(evaluate(os, arch, version, sidecar, model, true), expected);
    }
    assert_eq!(
        evaluate("windows", "x86_64", (10, 0), true, true, false),
        Ok("ready")
    );
    assert!(installed_model().is_none());
    let service = Service::default();
    let unavailable = service.capability();
    assert_eq!(unavailable["version"], 1);
    assert_eq!(unavailable["status"], "unavailable");
    assert_eq!(unavailable.as_object().unwrap().len(), 3);
    for _ in 0..33 {
        assert_eq!(service.capability(), unavailable);
        let result = service.run(coach()).await.unwrap();
        assert_eq!(result["error"], unavailable["reason"]);
        assert_eq!(result.as_object().unwrap().len(), 5);
    }
    // Unavailable calls do not consume admission records or create a busy owner.
    for _ in 0..32 {
        service.cancel(uuid::Uuid::new_v4().to_string()).unwrap();
    }
    assert_eq!(
        service.cancel(uuid::Uuid::new_v4().to_string()),
        Err(ErrorCode::Busy)
    );
    assert_eq!(service.capability(), unavailable);
}

#[tokio::test]
async fn closed_envelopes_reject_without_reflection_and_bad_inputs_keep_correlation() {
    let service = Service::default();
    for (key, bad) in [
        ("requestId", json!("PRIVATE_CANARY")),
        ("requestId", json!("f98b4102986b4abc9bb4760f7b136b7")),
        ("task", json!("completion")),
        ("documentRevision", json!(-1)),
        ("documentRevision", json!(1.5)),
        ("documentRevision", json!(9_007_199_254_740_992u64)),
        ("documentRevision", Value::Null),
        ("sourceSnapshotId", Value::Null),
        ("endpoint", json!("PRIVATE_CANARY")),
    ] {
        let mut request = coach();
        request[key] = bad;
        assert_eq!(
            service.run(request).await,
            Err(ErrorCode::InvalidRequest),
            "closed envelope field: {key}"
        );
    }
    for identity in ["", "bad/path", "Á", &"s".repeat(65)] {
        let mut request = coach();
        request.as_object_mut().unwrap().remove("documentRevision");
        request["sourceSnapshotId"] = json!(identity);
        assert_eq!(service.run(request).await, Err(ErrorCode::InvalidRequest));
    }
    for input in [
        Value::Null,
        json!({"documentLanguage":"fr","passage":{"sourceId":"p","snapshotId":"s","text":"x"}}),
        json!({"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":""}}),
        json!({"documentLanguage":"en","passage":{"sourceId":"p","snapshotId":"s","text":"x","modelPath":"PRIVATE_CANARY"}}),
        json!({"documentLanguage":"en","sources":[],"questionCount":5}),
    ] {
        let mut request = coach();
        request["input"] = input;
        assert_eq!(
            service.run(request).await.unwrap(),
            json!({"requestId":"f98b4102-986b-4abc-9bb4-b760f7b136b7","documentRevision":7,"task":"writingCoach","status":"error","error":"invalid-request"})
        );
    }
}

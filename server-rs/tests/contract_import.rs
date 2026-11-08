// 对齐 tests/import.test.js
use serde_json::{json, Value};
use shellpilot_server::crypt::{decrypt_data, encrypt_data};
use shellpilot_server::import::{prepare_import, validate_import_data, ImportOptions};

fn opts(host_ids: Option<Value>, provider_ids: Option<Value>, mode: Option<&str>) -> ImportOptions {
    ImportOptions {
        host_ids,
        provider_ids,
        mode: mode.map(String::from),
    }
}

fn empty() -> Value {
    json!({ "hosts": [], "settings": { "providers": [], "models": [] }, "chats": {} })
}

fn host(id: &str, address: &str) -> Value {
    json!({ "id": id, "name": id, "host": address, "port": 22, "username": "root" })
}

fn host_extra(id: &str, address: &str, extra: Value) -> Value {
    let mut h = host(id, address);
    let obj = h.as_object_mut().unwrap();
    for (k, v) in extra.as_object().unwrap() {
        obj.insert(k.clone(), v.clone());
    }
    h
}

fn provider(id: &str, base_url: &str) -> Value {
    json!({ "id": id, "name": id, "baseURL": base_url })
}

fn model(id: &str, provider_id: &str) -> Value {
    json!({ "id": id, "providerId": provider_id, "name": id })
}

fn model_name(id: &str, provider_id: &str, name: &str) -> Value {
    json!({ "id": id, "providerId": provider_id, "name": name })
}

fn chat(id: &str) -> Value {
    json!({ "id": id, "title": id, "messages": [{ "role": "user", "content": id }] })
}

#[test]
fn binary_exports_can_be_read_by_the_frontend_and_decrypted_intact() {
    let payload = serde_json::to_vec(&json!({ "version": 1, "note": "备份\u{0}内容" })).unwrap();
    let encrypted = encrypt_data(&payload, "test-password");
    let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&encrypted)
    };
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD.decode(&encoded).unwrap(),
        encrypted
    );
    assert_eq!(decrypt_data(&encrypted, "test-password").unwrap(), payload);
    // 覆盖跨编码分片及非 UTF-8 字节
    let large: Vec<u8> = (0..100000u32).map(|i| (i % 256) as u8).collect();
    let large_b64 = base64::engine::general_purpose::STANDARD.encode(&large);
    assert_eq!(
        base64::engine::general_purpose::STANDARD.decode(&large_b64).unwrap(),
        large
    );
    let err = decrypt_data(&encrypted, "wrong-password").unwrap_err();
    assert!(err.contains("密码错误"), "{err}");
    let mut damaged = encrypted.clone();
    let last = damaged.len() - 1;
    damaged[last] ^= 1;
    let err = decrypt_data(&damaged, "test-password").unwrap_err();
    assert!(err.contains("已损坏"), "{err}");
}

#[test]
fn host_id_collisions_do_not_attach_imported_chats_to_the_wrong_machine() {
    let mut current = empty();
    current["hosts"] = json!([host("h_shared", "192.0.2.1")]);
    current["chats"] = json!({ "h_shared": [chat("c_existing")] });
    let mut incoming = empty();
    incoming["hosts"] = json!([host("h_shared", "192.0.2.2")]);
    incoming["chats"] = json!({ "h_shared": [chat("c_imported")] });
    let before_current = current.clone();
    let before_incoming = incoming.clone();
    let result = prepare_import(&current, &incoming, opts(None, None, None)).unwrap();
    let added = result["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["host"] == "192.0.2.2")
        .unwrap();
    assert_ne!(added["id"], "h_shared");
    assert_eq!(
        result["chats"]["h_shared"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(),
        vec![json!("c_existing")]
    );
    let added_id = added["id"].as_str().unwrap().to_string();
    assert_eq!(
        result["chats"][&added_id].as_array().unwrap().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(),
        vec![json!("c_imported")]
    );
    assert_eq!(current, before_current);
    assert_eq!(incoming, before_incoming);
}

#[test]
fn only_selected_host_chats_are_merged_and_global_chats_survive_both_modes() {
    let mut current = empty();
    current["hosts"] = json!([host("h_existing", "192.0.2.1")]);
    current["chats"] = json!({ "__global__": [chat("c_old")] });
    let mut incoming = empty();
    incoming["hosts"] = json!([host("h_selected", "192.0.2.1"), host("h_skipped", "192.0.2.2")]);
    incoming["chats"] = json!({
        "h_selected": [chat("c_selected")],
        "h_skipped": [chat("c_skipped")],
        "__global__": [chat("c_global"), chat("c_global")]
    });
    let merged = prepare_import(
        &current,
        &incoming,
        opts(Some(json!(["h_selected"])), None, None),
    )
    .unwrap();
    assert_eq!(merged["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(
        merged["chats"]["h_existing"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(),
        vec![json!("c_selected")]
    );
    assert!(merged["chats"].get("h_skipped").is_none());
    assert_eq!(
        merged["chats"]["__global__"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(),
        vec![json!("c_old"), json!("c_global")]
    );
    let overwritten = prepare_import(
        &current,
        &incoming,
        opts(Some(json!(["h_selected"])), None, Some("overwrite")),
    )
    .unwrap();
    let mut keys: Vec<String> = overwritten["chats"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(keys, vec!["__global__".to_string(), "h_selected".to_string()]);
    assert_eq!(
        overwritten["chats"]["__global__"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(),
        vec![json!("c_global")]
    );
}

#[test]
fn jump_host_references_follow_remapped_ids_and_missing_dependencies_fail_before_writes() {
    let mut current = empty();
    current["hosts"] = json!([host("h_keep", "192.0.2.1"), host("h_jump", "192.0.2.9")]);
    let mut incoming = empty();
    incoming["hosts"] = json!([
        host("h_jump", "192.0.2.1"),
        host_extra("h_server", "192.0.2.2", json!({ "jumpHostId": "h_jump" }))
    ]);
    let result = prepare_import(
        &current,
        &incoming,
        opts(Some(json!(["h_server"])), None, None),
    )
    .unwrap();
    assert_eq!(
        result["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["id"] == "h_server")
            .unwrap()["jumpHostId"],
        "h_keep"
    );
    let err = prepare_import(&empty(), &incoming, opts(Some(json!(["h_server"])), None, None)).unwrap_err();
    assert!(err.contains("跳板机未导入"), "{err}");
    let all = prepare_import(&current, &incoming, opts(None, None, None)).unwrap();
    assert_eq!(
        all["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["id"] == "h_server")
            .unwrap()["jumpHostId"],
        "h_keep"
    );
    let mut cyclic = empty();
    cyclic["hosts"] = json!([
        host_extra("h_a", "192.0.2.1", json!({ "jumpHostId": "h_b" })),
        host_extra("h_b", "192.0.2.2", json!({ "jumpHostId": "h_a" }))
    ]);
    let err = prepare_import(&empty(), &cyclic, opts(None, None, None)).unwrap_err();
    assert!(err.contains("循环"), "{err}");
}

#[test]
fn provider_and_model_id_collisions_preserve_all_selected_models_and_their_references() {
    let mut current = empty();
    current["settings"] = json!({
        "providers": [provider("p_shared", "https://first.example/v1")],
        "models": [model("m_shared", "p_shared")],
        "defaultModelId": "m_shared"
    });
    let mut incoming = empty();
    incoming["settings"] = json!({
        "providers": [provider("p_shared", "https://second.example/v1")],
        "models": [model_name("m_shared", "p_shared", "new-model")],
        "defaultModelId": "m_shared",
        "approverModelId": "m_shared",
        "titleModelId": "m_shared"
    });
    let result = prepare_import(&current, &incoming, opts(None, None, None)).unwrap();
    assert_eq!(result["settings"]["providers"].as_array().unwrap().len(), 2);
    assert_eq!(result["settings"]["models"].as_array().unwrap().len(), 2);
    let added = result["settings"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["name"] == "new-model")
        .unwrap();
    assert_ne!(added["id"], "m_shared");
    assert_ne!(added["providerId"], "p_shared");
    assert_eq!(result["settings"]["defaultModelId"], "m_shared");
    assert_eq!(result["settings"]["approverModelId"], added["id"]);
    assert_eq!(result["settings"]["titleModelId"], added["id"]);
}

#[test]
fn matching_providers_and_model_names_keep_local_ids_and_repeated_imports_are_idempotent() {
    let mut current = empty();
    current["settings"] = json!({
        "providers": [provider("p_keep", "https://api.example/v1/")],
        "models": [model_name("m_keep", "p_keep", "same-model")],
        "defaultModelId": "m_keep"
    });
    let mut incoming = empty();
    incoming["settings"] = json!({
        "providers": [provider("p_source", "https://api.example/v1")],
        "models": [model_name("m_source", "p_source", "same-model")],
        "defaultModelId": "m_source",
        "titleModelId": "m_source"
    });
    incoming["chats"] = json!({ "__global__": [chat("c_one")] });
    let result = prepare_import(&current, &incoming, opts(None, None, None)).unwrap();
    assert_eq!(
        result["settings"]["models"],
        json!([model_name("m_keep", "p_keep", "same-model")])
    );
    assert_eq!(result["settings"]["defaultModelId"], "m_keep");
    assert_eq!(result["settings"]["titleModelId"], "m_keep");
    let again = prepare_import(&result.clone(), &incoming, opts(None, None, None)).unwrap();
    assert_eq!(again, result);
}

#[test]
fn removed_model_selections_are_repaired_and_overwrite_respects_provider_selection() {
    let mut current = empty();
    current["settings"] = json!({
        "providers": [provider("p_local", "https://api.example/v1")],
        "models": [model("m_old", "p_local")],
        "defaultModelId": "m_old",
        "approverModelId": "m_old",
        "titleModelId": "m_old"
    });
    let mut incoming = empty();
    incoming["settings"] = json!({
        "providers": [provider("p_import", "https://api.example/v1"), provider("p_skip", "https://skip.example/v1")],
        "models": [model("m_new", "p_import"), model("m_skip", "p_skip")],
        "defaultModelId": "m_skip",
        "titleModelId": "m_skip"
    });
    for mode in ["merge", "overwrite"] {
        let result = prepare_import(
            &current,
            &incoming,
            opts(None, Some(json!(["p_import"])), Some(mode)),
        )
        .unwrap();
        assert_eq!(result["settings"]["models"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["settings"]["defaultModelId"],
            result["settings"]["models"][0]["id"]
        );
        assert_eq!(result["settings"]["approverModelId"], Value::Null);
        assert_eq!(result["settings"]["titleModelId"], Value::Null);
    }
}

#[test]
fn invalid_backup_shapes_and_invalid_selections_are_rejected() {
    let invalids: Vec<Value> = vec![
        Value::Null,
        json!([]),
        json!({ "hosts": {} }),
        json!({ "settings": [] }),
        json!({ "settings": { "models": {} } }),
        json!({ "hosts": [host("../outside", "192.0.2.1")] }),
        json!({ "hosts": [host("h_one", "192.0.2.1"), host("h_one", "192.0.2.2")] }),
        json!({ "hosts": [host_extra("h_one", "192.0.2.1", json!({ "port": 65536 }))] }),
        json!({ "settings": { "models": [model("m_orphan", "p_missing")] } }),
        json!({ "chats": { "__global__": [{ "id": "c_invalid", "messages": "not-an-array" }] } }),
    ];
    for invalid in invalids {
        assert!(
            validate_import_data(&invalid).is_err(),
            "should reject: {invalid}"
        );
    }
    let err = prepare_import(&empty(), &empty(), opts(Some(json!("all")), None, None)).unwrap_err();
    assert!(err.contains("所选"), "{err}");
    let err = prepare_import(
        &empty(),
        &empty(),
        opts(None, Some(json!(["p_missing"])), None),
    )
    .unwrap_err();
    assert!(err.contains("所选"), "{err}");
    let err = prepare_import(&empty(), &empty(), opts(None, None, Some("unknown"))).unwrap_err();
    assert!(err.contains("模式"), "{err}");
}

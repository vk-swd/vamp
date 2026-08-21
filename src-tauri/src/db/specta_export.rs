/// Run `cargo test -p vampagent export_bindings -- --nocapture` from `src-tauri/`
/// to regenerate `src/db/generatedTypes.ts`.
/// Output path can be overridden with the SPECTA_OUT env var.
#[test]
fn export_bindings() {
    use specta::{Type, Types};
    use specta_typescript::Typescript;
    use specta_serde::PhasesFormat;

    let out = std::env::var("SPECTA_OUT").expect("SPECTA_OUT env var must be set");
    let types = Types::default()
    .register::<crate::db::filtered_schema::CriteriaName>()
    .register::<crate::db::filtered_schema::SearchCriteriaFiltered>()
    .register::<crate::defines::WsRequest>()
    .register::<crate::defines::WsResponse<String>>()
    ;

    Typescript::default()
        .export_to(&out, &types, specta_serde::PhasesFormat)
        .unwrap();
}

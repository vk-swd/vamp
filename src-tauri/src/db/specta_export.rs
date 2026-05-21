/// Run `cargo test -p vampagent export_bindings -- --nocapture` from `src-tauri/`
/// to regenerate `src/db/generatedTypes.ts`.
#[test]
fn export_bindings() {
    use specta::TypeCollection;
    use specta_typescript::Typescript;

    let mut types = TypeCollection::default();
    types.register::<crate::db::filtered_schema::CriteriaName>();
    types.register::<crate::db::filtered_schema::SearchCriteriaFiltered>();

    Typescript::default()
        .export_to("../../src/db/generatedTypes.ts", &types)
        .unwrap();
}

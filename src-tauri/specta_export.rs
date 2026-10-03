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
    .register::<crate::commands::dispatch::Command>()
    ;
    let out_transport = std::env::var("SPECTA_OUT_TRANSPORT").expect("SPECTA_OUT_TRANSPORT env var must be set");
    let types_transport = Types::default()
    .register::<crate::rtc::transport_types::WireMsg<()>>()
    .register::<crate::rtc::ws_node_handler::SignalMsg>()
    .register::<crate::defines::RemoteRequest<String>>()
    .register::<crate::defines::RemoteResponse<String>>()
    .register::<crate::defines::DataTransportMessage<String, String>>()
    ;
    Typescript::default()
        .export_to(&out, &types, specta_serde::PhasesFormat)
        .unwrap();
    Typescript::default()
        .export_to(&out_transport, &types_transport, specta_serde::PhasesFormat)
        .unwrap();
}

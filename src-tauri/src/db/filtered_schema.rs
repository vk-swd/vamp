//! Typed filter schema for `get_tracks_filtered`.
//!
//! These types mirror the search types in `schema.rs` but carry `specta::Type`
//! so they can be exported to TypeScript.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub enum FilterNumericOperator {
    #[serde(rename = "<")]  Lt,
    #[serde(rename = ">")]  Gt,
    #[serde(rename = "=")]  Eq,
    #[serde(rename = "<=")] Lte,
    #[serde(rename = ">=")] Gte,
    #[serde(rename = "!=")] Ne,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum FilterSearchParam {
    NumericComparison { operator: FilterNumericOperator, value: f64 },
    NumericBetween    { min: f64, max: f64 },
    TextLike          { pattern: String, case_sensitive: bool },
    TextIn            { values: Vec<String> },
    NullCheck         { is_null: bool },
    TagsIn            { tag_ids: Vec<i64> },
    TagsAll           { tag_ids: Vec<i64> },
}

/// Strongly-typed filter names accepted by `get_tracks_filtered`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CriteriaName {
    Id,
    Artist,
    TrackName,
    LengthSeconds,
    BitrateKbps,
    TempoBpm,
    AdditionTime,
    Tags,
}

/// Like `SearchCriteria` but with a typed `CriteriaName` and specta-exported params.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SearchCriteriaFiltered {
    pub filter_name: CriteriaName,
    pub criteria: Vec<FilterSearchParam>,
}

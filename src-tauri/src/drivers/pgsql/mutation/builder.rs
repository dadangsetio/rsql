//! Builds parameterized UPDATE and DELETE statements for grid row edits.
//!
//! Values arrive from the frontend as text, because that is how the simple
//! query protocol hands them out. Binding them as text and casting on the
//! Postgres side (`$1::text::<type>`) keeps every value out of the SQL string.
//! The double cast is deliberate: with a bare `$1::int4` Postgres infers the
//! parameter as `int4` while the client binds `&str`, which is a type mismatch.
//! `$1::text` pins the parameter to text and the second cast converts. The
//! compared column stays bare, so the expression folds to a constant at plan
//! time and indexes stay usable.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::common::enums::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MutationKind {
    Update,
    Delete,
    Insert,
}

/// One row mutation. `None` values are SQL NULL. `pk` is unused for `Insert` —
/// a new row has no key to match against yet.
#[derive(Debug, Clone, Deserialize)]
pub struct RowMutation {
    pub kind: MutationKind,
    #[serde(default)]
    pub set: Vec<(String, Option<String>)>,
    #[serde(default)]
    pub pk: Vec<(String, Option<String>)>,
}

/// A statement plus its bound parameters, in placeholder order.
#[derive(Debug, PartialEq, Eq)]
pub struct BuiltStatement {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

/// Column name to the type expression returned by `format_type`.
pub type ColumnTypes = BTreeMap<String, String>;

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Resolve a column's type, rejecting anything the table does not have. This is
/// what makes the statement injection-proof: names are matched against the live
/// catalog rather than merely quoted.
fn column_type<'a>(types: &'a ColumnTypes, column: &str) -> Result<&'a str, AppError> {
    types
        .get(column)
        .map(String::as_str)
        .ok_or_else(|| AppError::QueryFailed(format!("Unknown column \"{}\"", column)))
}

/// Append the key predicates and their parameters, returning the WHERE body.
fn build_key_predicates(
    key: &[(String, Option<String>)],
    types: &ColumnTypes,
    params: &mut Vec<Option<String>>,
) -> Result<String, AppError> {
    if key.is_empty() {
        return Err(AppError::QueryFailed(
            "Refusing to build a statement with no key columns".into(),
        ));
    }

    let mut predicates = Vec::with_capacity(key.len());
    for (column, value) in key {
        let ty = column_type(types, column)?;
        match value {
            None => predicates.push(format!("{} IS NULL", quote_ident(column))),
            Some(_) => {
                params.push(value.clone());
                predicates.push(format!(
                    "{} = ${}::text::{}",
                    quote_ident(column),
                    params.len(),
                    ty
                ));
            }
        }
    }

    Ok(predicates.join(" AND "))
}

pub fn build_statement(
    schema: &str,
    table: &str,
    mutation: &RowMutation,
    types: &ColumnTypes,
) -> Result<BuiltStatement, AppError> {
    let target = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let mut params: Vec<Option<String>> = Vec::new();

    let sql = match mutation.kind {
        MutationKind::Delete => {
            let where_clause = build_key_predicates(&mutation.pk, types, &mut params)?;
            format!("DELETE FROM {} WHERE {}", target, where_clause)
        }
        MutationKind::Update => {
            if mutation.set.is_empty() {
                return Err(AppError::QueryFailed(
                    "Refusing to build an UPDATE with no assignments".into(),
                ));
            }

            let mut assignments = Vec::with_capacity(mutation.set.len());
            for (column, value) in &mutation.set {
                let ty = column_type(types, column)?;
                params.push(value.clone());
                assignments.push(format!(
                    "{} = ${}::text::{}",
                    quote_ident(column),
                    params.len(),
                    ty
                ));
            }

            let where_clause = build_key_predicates(&mutation.pk, types, &mut params)?;
            format!(
                "UPDATE {} SET {} WHERE {}",
                target,
                assignments.join(", "),
                where_clause
            )
        }
        MutationKind::Insert => {
            if mutation.set.is_empty() {
                return Err(AppError::QueryFailed(
                    "Refusing to build an INSERT with no columns set".into(),
                ));
            }

            let mut idents = Vec::with_capacity(mutation.set.len());
            let mut placeholders = Vec::with_capacity(mutation.set.len());
            for (column, value) in &mutation.set {
                let ty = column_type(types, column)?;
                params.push(value.clone());
                idents.push(quote_ident(column));
                placeholders.push(format!("${}::text::{}", params.len(), ty));
            }

            format!(
                "INSERT INTO {} ({}) VALUES ({})",
                target,
                idents.join(", "),
                placeholders.join(", ")
            )
        }
    };

    Ok(BuiltStatement { sql, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types() -> ColumnTypes {
        [
            ("id", "bigint"),
            ("name", "character varying(255)"),
            ("tags", "text[]"),
            ("kind", "public.my_enum"),
            ("note", "text"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn cell(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    /// Regression guard, not a micro-benchmark: catches an accidental O(n^2) in
    /// statement building (e.g. a linear scan added to `column_type` or
    /// `build_key_predicates`) rather than tracking exact timings. The threshold
    /// is generous on purpose so ordinary machine/CI jitter never trips it.
    #[test]
    fn building_many_update_statements_stays_fast() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![
                ("name".into(), cell("ada")),
                ("note".into(), cell("lovelace")),
            ],
            pk: vec![("id".into(), cell("7"))],
        };
        let types = types();

        let start = std::time::Instant::now();
        for _ in 0..10_000 {
            build_statement("public", "t", &mutation, &types).unwrap();
        }
        let elapsed = start.elapsed();

        assert!(
            elapsed.as_millis() < 500,
            "building 10,000 UPDATE statements took {:?}, expected well under 500ms — \
             check for an accidentally quadratic path in build_statement",
            elapsed
        );
    }

    #[test]
    fn delete_casts_the_key_parameter_to_the_column_type() {
        let mutation = RowMutation {
            kind: MutationKind::Delete,
            set: vec![],
            pk: vec![("id".into(), cell("7"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(
            built.sql,
            "DELETE FROM \"public\".\"t\" WHERE \"id\" = $1::text::bigint"
        );
        assert_eq!(built.params, vec![cell("7")]);
    }

    #[test]
    fn update_numbers_assignments_before_key_predicates() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![("name".into(), cell("ada"))],
            pk: vec![("id".into(), cell("7"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(
            built.sql,
            "UPDATE \"public\".\"t\" SET \"name\" = $1::text::character varying(255) \
             WHERE \"id\" = $2::text::bigint"
        );
        assert_eq!(built.params, vec![cell("ada"), cell("7")]);
    }

    #[test]
    fn a_null_key_becomes_is_null_and_consumes_no_placeholder() {
        let mutation = RowMutation {
            kind: MutationKind::Delete,
            set: vec![],
            pk: vec![("note".into(), None), ("id".into(), cell("7"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(
            built.sql,
            "DELETE FROM \"public\".\"t\" WHERE \"note\" IS NULL AND \"id\" = $1::text::bigint"
        );
        assert_eq!(built.params, vec![cell("7")]);
    }

    #[test]
    fn a_null_assignment_binds_null_rather_than_the_text_null() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![("note".into(), None)],
            pk: vec![("id".into(), cell("7"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(built.params, vec![None, cell("7")]);
    }

    #[test]
    fn the_text_null_is_bound_as_a_value() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![("note".into(), cell("null"))],
            pk: vec![("id".into(), cell("7"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(built.params, vec![cell("null"), cell("7")]);
    }

    #[test]
    fn composite_keys_are_all_required() {
        let mutation = RowMutation {
            kind: MutationKind::Delete,
            set: vec![],
            pk: vec![("id".into(), cell("7")), ("name".into(), cell("ada"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert!(built.sql.contains("\"id\" = $1::text::bigint"));
        assert!(
            built
                .sql
                .contains("\"name\" = $2::text::character varying(255)")
        );
        assert_eq!(built.params.len(), 2);
    }

    #[test]
    fn array_and_enum_columns_use_their_catalog_type() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![
                ("tags".into(), cell("{a,b}")),
                ("kind".into(), cell("active")),
            ],
            pk: vec![("id".into(), cell("7"))],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert!(built.sql.contains("\"tags\" = $1::text::text[]"));
        assert!(built.sql.contains("\"kind\" = $2::text::public.my_enum"));
    }

    #[test]
    fn unknown_columns_are_rejected() {
        let mutation = RowMutation {
            kind: MutationKind::Delete,
            set: vec![],
            pk: vec![("id; DROP TABLE users".into(), cell("7"))],
        };
        let err = build_statement("public", "t", &mutation, &types()).unwrap_err();
        assert!(err.to_string().contains("Unknown column"));
    }

    #[test]
    fn an_unknown_assignment_column_is_rejected() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![("nope".into(), cell("x"))],
            pk: vec![("id".into(), cell("7"))],
        };
        assert!(build_statement("public", "t", &mutation, &types()).is_err());
    }

    #[test]
    fn a_statement_without_key_columns_is_refused() {
        let mutation = RowMutation {
            kind: MutationKind::Delete,
            set: vec![],
            pk: vec![],
        };
        let err = build_statement("public", "t", &mutation, &types()).unwrap_err();
        assert!(err.to_string().contains("no key columns"));
    }

    #[test]
    fn an_update_without_assignments_is_refused() {
        let mutation = RowMutation {
            kind: MutationKind::Update,
            set: vec![],
            pk: vec![("id".into(), cell("7"))],
        };
        let err = build_statement("public", "t", &mutation, &types()).unwrap_err();
        assert!(err.to_string().contains("no assignments"));
    }

    #[test]
    fn insert_lists_columns_and_casts_each_value_to_its_type() {
        let mutation = RowMutation {
            kind: MutationKind::Insert,
            set: vec![("id".into(), cell("7")), ("name".into(), cell("ada"))],
            pk: vec![],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(
            built.sql,
            "INSERT INTO \"public\".\"t\" (\"id\", \"name\") \
             VALUES ($1::text::bigint, $2::text::character varying(255))"
        );
        assert_eq!(built.params, vec![cell("7"), cell("ada")]);
    }

    #[test]
    fn insert_binds_a_null_column_as_null_rather_than_the_text_null() {
        let mutation = RowMutation {
            kind: MutationKind::Insert,
            set: vec![("note".into(), None)],
            pk: vec![],
        };
        let built = build_statement("public", "t", &mutation, &types()).unwrap();
        assert_eq!(built.params, vec![None]);
    }

    #[test]
    fn an_insert_with_no_columns_set_is_refused() {
        let mutation = RowMutation {
            kind: MutationKind::Insert,
            set: vec![],
            pk: vec![],
        };
        let err = build_statement("public", "t", &mutation, &types()).unwrap_err();
        assert!(err.to_string().contains("no columns set"));
    }

    #[test]
    fn identifiers_containing_quotes_are_escaped() {
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn schema_and_table_names_are_quoted() {
        let mutation = RowMutation {
            kind: MutationKind::Delete,
            set: vec![],
            pk: vec![("id".into(), cell("1"))],
        };
        let built = build_statement("my schema", "my table", &mutation, &types()).unwrap();
        assert!(
            built
                .sql
                .starts_with("DELETE FROM \"my schema\".\"my table\" ")
        );
    }
}

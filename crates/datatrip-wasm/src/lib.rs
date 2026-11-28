use datatrip_import_format::preview::{self, ImportFormat, PREVIEW_BYTES};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct Options {
    name: String,
    size: u64,
    format: Option<ImportFormat>,
    checks: Option<Vec<Option<String>>>,
}

#[wasm_bindgen]
pub fn import_preview(bytes: &[u8], options: &str) -> Result<String, JsError> {
    let options: Options = serde_json::from_str(options)?;
    if bytes.len() > PREVIEW_BYTES || bytes.len() as u64 > options.size {
        return Err(JsError::new("Invalid import sample size"));
    }
    let result = preview::preview(
        &options.name,
        bytes,
        options.size,
        &options.format.unwrap_or_default(),
        options.checks.as_deref(),
    )
    .map_err(|message| JsError::new(&message))?;
    Ok(serde_json::to_string(&result)?)
}

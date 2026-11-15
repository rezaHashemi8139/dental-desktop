use std::fmt::Display;

use serde::Serialize;
use serde_json::{Map, Value};

/// Text shown to the user, sent to the frontend as a translation key plus values.
///
/// Rust never contains user-facing text: the frontend looks `key` up in the
/// active language file (`src/locales/*.json`) and fills in `params`, e.g.
/// `Message::new("greet.message").with("name", "Ali")` is shown with the
/// `"greet.message": "Hello, {{name}}!"` entry of the selected language.
///
/// Commands return it both as a success value and as an error.
#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub key: String,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

impl Message {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            params: Map::new(),
        }
    }

    /// Adds a value for a `{{name}}` placeholder in the translation.
    pub fn with(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.params.insert(name.to_owned(), value.into());
        self
    }

    /// An error message whose translation shows the technical cause as `{{details}}`.
    pub fn error(key: impl Into<String>, details: impl Display) -> Self {
        Self::new(key).with("details", details.to_string())
    }
}

use thiserror::Error;

/// Errors that can occur in the SDK.
#[derive(Error, Debug)]
pub enum WeChatBotError {
    #[error("API error: {message} (http={http_status}, errcode={errcode})")]
    Api {
        message: String,
        http_status: u16,
        errcode: i32,
    },

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("No context_token for user {0}")]
    NoContext(String),

    #[error("Media error: {0}")]
    Media(String),

    #[error("Transport error: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl WeChatBotError {
    /// Returns true if this is a session-expired error (errcode -14).
    pub fn is_session_expired(&self) -> bool {
        matches!(self, WeChatBotError::Api { errcode: -14, .. })
    }
}

pub type Result<T> = std::result::Result<T, WeChatBotError>;

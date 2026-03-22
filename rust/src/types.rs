use serde::{Deserialize, Serialize};
use std::time::SystemTime;

/// Message sender type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i32)]
pub enum MessageType {
    User = 1,
    Bot = 2,
}

/// Message delivery state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i32)]
pub enum MessageState {
    New = 0,
    Generating = 1,
    Finish = 2,
}

/// Content type of a message item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i32)]
pub enum MessageItemType {
    Text = 1,
    Image = 2,
    Voice = 3,
    File = 4,
    Video = 5,
}

/// Media type for upload requests.
#[derive(Debug, Clone, Copy)]
#[repr(i32)]
pub enum MediaType {
    Image = 1,
    Video = 2,
    File = 3,
    Voice = 4,
}

/// CDN media reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CDNMedia {
    pub encrypt_query_param: String,
    pub aes_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypt_type: Option<i32>,
}

/// Text content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextItem {
    pub text: String,
}

/// Image content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CDNMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_media: Option<CDNMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aeskey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_height: Option<i32>,
}

/// Voice content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CDNMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encode_type: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playtime: Option<i32>,
}

/// File content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CDNMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub len: Option<String>,
}

/// Video content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CDNMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_length: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_media: Option<CDNMedia>,
}

/// Referenced/quoted message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_item: Option<Box<WireMessageItem>>,
}

/// A single content item in a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessageItem {
    #[serde(rename = "type")]
    pub item_type: MessageItemType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_item: Option<TextItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_item: Option<ImageItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_item: Option<VoiceItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_item: Option<FileItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_item: Option<VideoItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_msg: Option<RefMessage>,
}

/// Raw wire message from the iLink API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub from_user_id: String,
    pub to_user_id: String,
    pub client_id: String,
    pub create_time_ms: i64,
    pub message_type: MessageType,
    pub message_state: MessageState,
    pub context_token: String,
    pub item_list: Vec<WireMessageItem>,
}

/// Parsed incoming message — user-friendly.
#[derive(Debug, Clone)]
pub struct IncomingMessage {
    pub user_id: String,
    pub text: String,
    pub content_type: ContentType,
    pub timestamp: SystemTime,
    pub images: Vec<ImageContent>,
    pub voices: Vec<VoiceContent>,
    pub files: Vec<FileContent>,
    pub videos: Vec<VideoContent>,
    pub quoted: Option<QuotedMessage>,
    pub raw: WireMessage,
    pub(crate) context_token: String,
}

/// Content type of an incoming message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentType {
    Text,
    Image,
    Voice,
    File,
    Video,
}

#[derive(Debug, Clone)]
pub struct ImageContent {
    pub media: Option<CDNMedia>,
    pub thumb_media: Option<CDNMedia>,
    pub aes_key: Option<String>,
    pub url: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct VoiceContent {
    pub media: Option<CDNMedia>,
    pub text: Option<String>,
    pub duration_ms: Option<i32>,
    pub encode_type: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct FileContent {
    pub media: Option<CDNMedia>,
    pub file_name: Option<String>,
    pub md5: Option<String>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct VideoContent {
    pub media: Option<CDNMedia>,
    pub thumb_media: Option<CDNMedia>,
    pub duration_ms: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct QuotedMessage {
    pub title: Option<String>,
    pub text: Option<String>,
}

/// Stored login credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub token: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
}

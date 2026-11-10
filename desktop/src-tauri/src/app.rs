use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use reqwest::{redirect::Policy, Client};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{
    webview::NewWindowResponse, AppHandle, Emitter, Manager, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use unicode_normalization::UnicodeNormalization;
use url::Url;
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const MAX_DESKTOP_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const BRIDGE_SCRIPT: &str = r#"(() => {
  const api = window.__TAURI__;
  if (!api?.core?.invoke || !api?.event?.listen) return;
  const invoke = api.core.invoke;
  const changed = (callback) => {
    let disposed = false;
    let unlisten = null;
    const pending = api.event.listen('connections:changed', (event) => callback(event.payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; void pending.then(() => unlisten?.()); };
  };
  const shell = {
    mode: 'desktop', initialProfileId: null, currentVersion: '__CODE_REMOTE_DESKTOP_VERSION__',
    listConnections: () => invoke('connection_list'),
    pairConnection: (input) => invoke('connection_pair', { input }),
    renameConnection: (input) => invoke('connection_rename', { input }),
    removeConnection: (input) => invoke('connection_remove', { input }),
    activateConnection: (profileId) => invoke('connection_activate', { profileId }),
    showConnectionManager: () => invoke('connection_activate', { profileId: null }),
    openConnectionWindow: (profileId) => invoke('connection_open_window', { profileId }),
    checkDesktopUpdate: () => invoke('desktop_update_check'),
    downloadDesktopUpdate: () => invoke('desktop_update_download'),
    installDesktopUpdate: () => invoke('desktop_update_install'),
    setOverlayOpen: async () => true,
    onConnectionsChanged: changed,
  };
  window.codeRemoteDesktop = shell;
  window.CodeRemoteDesktop = {
    getToken: () => null,
    getTokenAsync: () => invoke('remote_get_token'),
    saveToken: (token) => invoke('remote_save_token', { token }),
    clearToken: () => invoke('remote_clear_token'),
    getCurrentConnectionId: () => invoke('remote_current_connection'),
    listConnections: shell.listConnections,
    pairConnection: shell.pairConnection,
    renameConnection: shell.renameConnection,
    removeConnection: shell.removeConnection,
    activateConnection: shell.activateConnection,
    showConnectionManager: shell.showConnectionManager,
    openConnectionWindow: shell.openConnectionWindow,
    checkDesktopUpdate: shell.checkDesktopUpdate,
    downloadDesktopUpdate: shell.downloadDesktopUpdate,
    installDesktopUpdate: shell.installDesktopUpdate,
    onConnectionsChanged: changed,
  };
  const installLegacyPairingCompatibility = () => {
    if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') return true;
    if (document.querySelector('[data-desktop-device-management="integrated"]')) return true;
    if (document.querySelector('.remote-shell')) return true;
    const card = document.querySelector('.pair-card');
    if (!card) return false;
    if (card.querySelector('[data-code-remote-desktop-manager]')) return true;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.codeRemoteDesktopManager = 'true';
    button.textContent = document.documentElement.lang.toLowerCase().startsWith('en')
      ? 'Manage other devices' : '管理其他设备';
    button.style.cssText = 'width:100%;min-height:36px;margin-top:14px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.82';
    button.addEventListener('click', () => { void shell.showConnectionManager(); });
    card.append(button);
    void invoke('remote_get_token').then((token) => {
      if (typeof token !== 'string' || !token) return;
      try {
        const syncKey = 'code-remote.desktop-legacy-token';
        if (localStorage.getItem('codex-remote-token') === token || sessionStorage.getItem(syncKey) === token) return;
        localStorage.setItem('codex-remote-token', token);
        sessionStorage.setItem(syncKey, token);
        location.reload();
      } catch (_) {
        // The manager button remains available when legacy storage is unavailable.
      }
    }).catch(() => undefined);
    return true;
  };
  const startLegacyPairingCompatibility = () => {
    if (installLegacyPairingCompatibility()) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (installLegacyPairingCompatibility() || attempts >= 40) window.clearInterval(timer);
    }, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startLegacyPairingCompatibility, { once: true });
  else startLegacyPairingCompatibility();
})();"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredConnection {
    id: String,
    name: String,
    endpoint: String,
    #[serde(default)]
    encrypted_token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicConnection {
    id: String,
    name: String,
    endpoint: String,
    paired: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateManifest {
    version: String,
    filename: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateStatus {
    current_version: String,
    latest_version: String,
    available: bool,
    filename: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedDesktopUpdate {
    version: String,
    filename: String,
    size_bytes: u64,
}

#[derive(Clone)]
struct PendingDesktopUpdate {
    path: PathBuf,
    profile_id: String,
    version: String,
    filename: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairInput {
    name: String,
    endpoint: String,
    code: String,
}

#[derive(Deserialize)]
struct RenameInput {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct RemoveInput {
    id: String,
}

#[derive(Deserialize)]
struct StoredConnections {
    version: u32,
    connections: Vec<StoredConnection>,
}

struct DesktopState {
    profiles: Mutex<Vec<StoredConnection>>,
    window_profiles: Mutex<HashMap<String, String>>,
    pending_update: Mutex<Option<PendingDesktopUpdate>>,
    store_path: PathBuf,
}

impl DesktopState {
    fn profile(&self, id: &str) -> Result<StoredConnection, String> {
        self.profiles
            .lock()
            .map_err(|_| "本机连接存储暂时不可用。".to_string())?
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
            .ok_or_else(|| "找不到这台设备。".to_string())
    }

    fn public_profiles(&self) -> Result<Vec<PublicConnection>, String> {
        let profiles = self
            .profiles
            .lock()
            .map_err(|_| "本机连接存储暂时不可用。".to_string())?;
        Ok(profiles.iter().map(public_profile).collect())
    }

    fn save_locked(&self, profiles: &[StoredConnection]) -> Result<(), String> {
        persist_profiles(&self.store_path, profiles)
    }
}

fn public_profile(profile: &StoredConnection) -> PublicConnection {
    PublicConnection {
        id: profile.id.clone(),
        name: profile.name.clone(),
        endpoint: profile.endpoint.clone(),
        paired: !profile.encrypted_token.is_empty(),
    }
}

fn normalize_endpoint(value: &str) -> Result<Url, String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("请填写 Code Remote 网页地址。".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| "网页地址格式无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请使用有效的 HTTP 或 HTTPS 地址，不要带账号、查询参数或片段。".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url)
}

fn api_url(endpoint: &Url, route: &str) -> Result<Url, String> {
    let mut url = endpoint.clone();
    let base_path = endpoint.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}{route}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn normalize_pairing_code(value: &str) -> Result<String, String> {
    let code = value
        .nfkc()
        .flat_map(char::to_uppercase)
        .filter(|character| {
            !character.is_whitespace() && !matches!(character, '-' | '_' | '\u{200b}' | '\u{feff}')
        })
        .collect::<String>();
    if code.chars().count() != 8 {
        return Err("请输入电脑终端显示的 8 位匹配码。".into());
    }
    Ok(code)
}

fn persist_profiles(path: &Path, profiles: &[StoredConnection]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法确定本机连接存储目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "无法创建本机连接存储目录。".to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let contents = serde_json::to_vec_pretty(&json!({
        "version": STORE_VERSION,
        "connections": profiles,
    }))
    .map_err(|_| "无法保存本机连接。".to_string())?;
    fs::write(&temporary, contents).map_err(|_| "无法保存本机连接。".to_string())?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法保存本机连接：{error}"));
    }
    Ok(())
}

fn load_profiles(path: &Path) -> Vec<StoredConnection> {
    let Ok(contents) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(store) = serde_json::from_slice::<StoredConnections>(&contents) else {
        return Vec::new();
    };
    if store.version != STORE_VERSION {
        return Vec::new();
    }
    store
        .connections
        .into_iter()
        .filter_map(|mut profile| {
            let endpoint = normalize_endpoint(&profile.endpoint).ok()?;
            if profile.id.is_empty() || profile.name.trim().is_empty() {
                return None;
            }
            profile.endpoint = endpoint.to_string().trim_end_matches('/').to_string();
            profile.name = profile.name.trim().chars().take(48).collect();
            Some(profile)
        })
        .collect()
}

fn migrate_legacy_profiles(app: &AppHandle, store_path: &Path) -> Vec<StoredConnection> {
    if store_path.exists() {
        return load_profiles(store_path);
    }
    let mut candidates = Vec::new();
    if let Some(roaming) = std::env::var_os("APPDATA") {
        let roaming = PathBuf::from(roaming);
        for directory in ["Code Remote", "code-remote-desktop", "Code-Remote-Desktop"] {
            candidates.push(roaming.join(directory).join("connections.json"));
        }
    }
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let parent = app_data_dir.parent().unwrap_or(&app_data_dir);
        for directory in ["Code Remote", "code-remote-desktop", "Code-Remote-Desktop"] {
            candidates.push(parent.join(directory).join("connections.json"));
        }
    }
    candidates.sort();
    candidates.dedup();
    for candidate in candidates {
        if candidate == store_path {
            continue;
        }
        let profiles = load_profiles(&candidate);
        if !profiles.is_empty() && persist_profiles(store_path, &profiles).is_ok() {
            return profiles;
        }
    }
    Vec::new()
}

fn is_local_shell_url(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn current_profile_id(window: &WebviewWindow, state: &DesktopState) -> Result<String, String> {
    let id = state
        .window_profiles
        .lock()
        .map_err(|_| "桌面窗口状态暂时不可用。".to_string())?
        .get(window.label())
        .cloned()
        .ok_or_else(|| "当前网页没有有效的桌面连接。".to_string())?;
    let profile = state.profile(&id)?;
    let current_url = window
        .url()
        .map_err(|_| "无法读取当前网页地址。".to_string())?;
    let endpoint = normalize_endpoint(&profile.endpoint)?;
    if current_url.origin() != endpoint.origin() {
        return Err("当前网页没有有效的桌面连接。".into());
    }
    Ok(id)
}

fn authorize_manager(window: &WebviewWindow, state: &DesktopState) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "无法读取当前网页地址。".to_string())?;
    if is_local_shell_url(&url) {
        let is_assigned = state
            .window_profiles
            .lock()
            .map_err(|_| "桌面窗口状态暂时不可用。".to_string())?
            .contains_key(window.label());
        if !is_assigned {
            return Ok(());
        }
    }
    current_profile_id(window, state).map(|_| ())
}

fn notify_profiles(app: &AppHandle, state: &DesktopState) {
    if let Ok(profiles) = state.public_profiles() {
        let _ = app.emit("connections:changed", profiles);
    }
}

fn app_home_url() -> Result<Url, String> {
    #[cfg(windows)]
    let address = "http://tauri.localhost";
    #[cfg(not(windows))]
    let address = "tauri://localhost";
    let mut url = Url::parse(address).map_err(|_| "无法打开 Code Remote。".to_string())?;
    url.query_pairs_mut().append_pair("view", "devices");
    Ok(url)
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if matches!(url.scheme(), "https" | "http" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn navigation_allowed<R: Runtime>(app: &AppHandle<R>, label: &str, url: &Url) -> bool {
    if is_local_shell_url(url) {
        let state = app.state::<DesktopState>();
        let has_profile = state
            .window_profiles
            .lock()
            .map(|profiles| profiles.contains_key(label))
            .unwrap_or(true);
        return !has_profile;
    }

    let state = app.state::<DesktopState>();
    let profile_id = state
        .window_profiles
        .lock()
        .ok()
        .and_then(|profiles| profiles.get(label).cloned());
    if let Some(profile_id) = profile_id {
        if let Ok(profile) = state.profile(&profile_id) {
            if let Ok(endpoint) = normalize_endpoint(&profile.endpoint) {
                if url.origin() == endpoint.origin() {
                    return true;
                }
            }
        }
    }
    open_external(app, url);
    false
}

fn make_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    title: &str,
    url: WebviewUrl,
    width: f64,
    height: f64,
) -> tauri::Result<WebviewWindow<R>> {
    let app_for_navigation = app.clone();
    let app_for_popup = app.clone();
    let navigation_label = label.to_string();
    WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(width, height)
        .min_inner_size(900.0, 580.0)
        .center()
        .initialization_script(
            BRIDGE_SCRIPT.replace("__CODE_REMOTE_DESKTOP_VERSION__", env!("CARGO_PKG_VERSION")),
        )
        .on_navigation(move |target| {
            navigation_allowed(&app_for_navigation, &navigation_label, target)
        })
        .on_new_window(move |target, _features| {
            open_external(&app_for_popup, &target);
            NewWindowResponse::Deny
        })
        .build()
}

fn profile_url(profile: &StoredConnection) -> Result<Url, String> {
    normalize_endpoint(&profile.endpoint)
}

fn activate_window(
    window: &WebviewWindow,
    state: &DesktopState,
    profile_id: Option<&str>,
) -> Result<(), String> {
    let destination = if let Some(profile_id) = profile_id {
        let profile = state.profile(profile_id)?;
        state
            .window_profiles
            .lock()
            .map_err(|_| "桌面窗口状态暂时不可用。".to_string())?
            .insert(window.label().to_string(), profile.id.clone());
        window
            .set_title(&format!("{} — Code Remote", profile.name))
            .map_err(|_| "无法更新窗口标题。".to_string())?;
        profile_url(&profile)?
    } else {
        state
            .window_profiles
            .lock()
            .map_err(|_| "桌面窗口状态暂时不可用。".to_string())?
            .remove(window.label());
        window
            .set_title("Code Remote")
            .map_err(|_| "无法更新窗口标题。".to_string())?;
        app_home_url()?
    };
    window
        .navigate(destination)
        .map_err(|_| "无法打开设备网页。".to_string())
}

#[tauri::command]
fn connection_list(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Vec<PublicConnection>, String> {
    authorize_manager(&window, &state)?;
    state.public_profiles()
}

#[tauri::command]
async fn connection_pair(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    input: PairInput,
) -> Result<serde_json::Value, String> {
    authorize_manager(&window, &state)?;
    let endpoint = normalize_endpoint(&input.endpoint)?;
    let code = normalize_pairing_code(&input.code)?;
    let pair_url = api_url(&endpoint, "/api/v1/pair")?;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "连接失败，请检查网页地址和网络。".to_string())?;
    let response = client
        .post(pair_url)
        .json(&json!({ "code": code }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "连接超时，请确认 Code Remote 服务正在运行。".to_string()
            } else {
                "连接失败，请检查网页地址和网络。".to_string()
            }
        })?;
    let status = response.status();
    let payload = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or_default();
    if !status.is_success()
        || payload
            .get("token")
            .and_then(|value| value.as_str())
            .is_none()
    {
        return Err(payload
            .get("detail")
            .and_then(|value| value.as_str())
            .unwrap_or("配对失败，请检查匹配码。")
            .to_string());
    }
    let token = payload["token"].as_str().unwrap_or_default();
    let encrypted_token = encrypt_token(token)?;
    let id = Uuid::new_v4().to_string();
    let host = endpoint.host_str().unwrap_or("Code Remote");
    let name = if input.name.trim().is_empty() {
        host.to_string()
    } else {
        input.name.trim().chars().take(48).collect()
    };
    let profile = StoredConnection {
        id: id.clone(),
        name,
        endpoint: endpoint.to_string().trim_end_matches('/').to_string(),
        encrypted_token,
    };
    {
        let mut profiles = state
            .profiles
            .lock()
            .map_err(|_| "本机连接存储暂时不可用。".to_string())?;
        profiles.insert(0, profile);
        state.save_locked(&profiles)?;
    }
    notify_profiles(&app, &state);
    Ok(json!({ "profiles": state.public_profiles()?, "profileId": id }))
}

#[tauri::command]
fn connection_rename(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    input: RenameInput,
) -> Result<Vec<PublicConnection>, String> {
    authorize_manager(&window, &state)?;
    let name = input.name.trim().chars().take(48).collect::<String>();
    if name.is_empty() {
        return Err("设备名称不能为空。".into());
    }
    let mut profiles = state
        .profiles
        .lock()
        .map_err(|_| "本机连接存储暂时不可用。".to_string())?;
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.id == input.id)
        .ok_or_else(|| "找不到这台设备。".to_string())?;
    profile.name = name;
    state.save_locked(&profiles)?;
    drop(profiles);
    for target in app.webview_windows().values() {
        if state
            .window_profiles
            .lock()
            .map(|profiles| profiles.get(target.label()) == Some(&input.id))
            .unwrap_or(false)
        {
            let _ = target.set_title(&format!("{} — Code Remote", input.name.trim()));
        }
    }
    notify_profiles(&app, &state);
    state.public_profiles()
}

#[tauri::command]
async fn connection_remove(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    input: RemoveInput,
) -> Result<serde_json::Value, String> {
    authorize_manager(&window, &state)?;
    let profile = match state.profile(&input.id) {
        Ok(profile) => profile,
        Err(_) => {
            return Ok(json!({ "profiles": state.public_profiles()?, "remoteRevoked": true }))
        }
    };
    let token = decrypt_token(&profile.encrypted_token);
    let mut remote_revoked = token.is_none();
    if let Some(token) = token {
        let endpoint = normalize_endpoint(&profile.endpoint)?;
        let unpair_url = api_url(&endpoint, "/api/v1/unpair")?;
        if let Ok(client) = Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(Policy::none())
            .build()
        {
            if let Ok(response) = client.post(unpair_url).bearer_auth(token).send().await {
                remote_revoked = response.status().is_success();
            }
        }
    }
    {
        let mut profiles = state
            .profiles
            .lock()
            .map_err(|_| "本机连接存储暂时不可用。".to_string())?;
        profiles.retain(|profile| profile.id != input.id);
        state.save_locked(&profiles)?;
    }
    for target in app.webview_windows().values() {
        let active = state
            .window_profiles
            .lock()
            .map(|profiles| profiles.get(target.label()) == Some(&input.id))
            .unwrap_or(false);
        if active {
            let _ =
                target.eval("try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}");
            let _ = activate_window(target, &state, None);
        }
    }
    notify_profiles(&app, &state);
    Ok(json!({ "profiles": state.public_profiles()?, "remoteRevoked": remote_revoked }))
}

#[tauri::command]
fn connection_activate(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    profile_id: Option<String>,
) -> Result<bool, String> {
    authorize_manager(&window, &state)?;
    activate_window(&window, &state, profile_id.as_deref())?;
    Ok(true)
}

#[tauri::command]
fn connection_open_window(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    profile_id: String,
) -> Result<bool, String> {
    authorize_manager(&window, &state)?;
    let profile = state.profile(&profile_id)?;
    let endpoint = profile_url(&profile)?;
    let label = format!("remote-{}", Uuid::new_v4());
    state
        .window_profiles
        .lock()
        .map_err(|_| "桌面窗口状态暂时不可用。".to_string())?
        .insert(label.clone(), profile.id);
    if let Err(error) = make_window(
        &app,
        &label,
        &format!("{} — Code Remote", profile.name),
        WebviewUrl::External(endpoint),
        1320.0,
        860.0,
    ) {
        if let Ok(mut profiles) = state.window_profiles.lock() {
            profiles.remove(&label);
        }
        return Err(error.to_string());
    }
    Ok(true)
}

#[tauri::command]
fn remote_current_connection(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    authorize_manager(&window, &state)?;
    let url = window
        .url()
        .map_err(|_| "无法读取当前网页地址。".to_string())?;
    if is_local_shell_url(&url)
        && !state
            .window_profiles
            .lock()
            .map_err(|_| "桌面窗口状态暂时不可用。".to_string())?
            .contains_key(window.label())
    {
        return Ok(None);
    }
    current_profile_id(&window, &state).map(Some)
}

#[tauri::command]
fn remote_get_token(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    let profile_id = current_profile_id(&window, &state)?;
    let profile = state.profile(&profile_id)?;
    Ok(decrypt_token(&profile.encrypted_token))
}

#[tauri::command]
fn remote_save_token(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    token: String,
) -> Result<bool, String> {
    let profile_id = current_profile_id(&window, &state)?;
    if token.len() < 16 {
        return Ok(false);
    }
    let encrypted_token = encrypt_token(&token)?;
    let mut profiles = state
        .profiles
        .lock()
        .map_err(|_| "本机连接存储暂时不可用。".to_string())?;
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "找不到这台设备。".to_string())?;
    profile.encrypted_token = encrypted_token;
    state.save_locked(&profiles)?;
    drop(profiles);
    notify_profiles(&app, &state);
    Ok(true)
}

#[tauri::command]
fn remote_clear_token(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
    let profile_id = current_profile_id(&window, &state)?;
    let mut profiles = state
        .profiles
        .lock()
        .map_err(|_| "本机连接存储暂时不可用。".to_string())?;
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "找不到这台设备。".to_string())?;
    profile.encrypted_token.clear();
    state.save_locked(&profiles)?;
    drop(profiles);
    notify_profiles(&app, &state);
    Ok(true)
}

fn project_version_phase(version: &Version) -> Result<(u8, u64), String> {
    if !version.build.is_empty() {
        return Err("版本号不能包含构建元数据。".into());
    }
    if version.pre.is_empty() {
        return Ok((2, 0));
    }
    let mut parts = version.pre.as_str().split('.');
    let phase = match parts.next() {
        Some("dev") => 0,
        Some("beta") => 1,
        _ => return Err("版本号只能使用 dev 或 beta 预发布标记。".into()),
    };
    let sequence = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "预发布版本号必须包含正整数序号。".to_string())?;
    if parts.next().is_some() {
        return Err("预发布版本号格式无效。".into());
    }
    Ok((phase, sequence))
}

fn parse_project_version(value: &str) -> Result<Version, String> {
    let version = Version::parse(value).map_err(|_| "更新清单中的版本号无效。".to_string())?;
    if version.to_string() != value {
        return Err("更新清单中的版本号格式无效。".into());
    }
    project_version_phase(&version)?;
    Ok(version)
}

fn compare_project_versions(left: &Version, right: &Version) -> Result<Ordering, String> {
    let left_phase = project_version_phase(left)?;
    let right_phase = project_version_phase(right)?;
    Ok((
        left.major,
        left.minor,
        left.patch,
        left_phase.0,
        left_phase.1,
    )
        .cmp(&(
            right.major,
            right.minor,
            right.patch,
            right_phase.0,
            right_phase.1,
        )))
}

fn validate_update_manifest(manifest: &DesktopUpdateManifest) -> Result<Version, String> {
    let version = parse_project_version(&manifest.version)?;
    if manifest.filename != format!("Code-Remote-Desktop-{}-x64.exe", manifest.version) {
        return Err("更新清单中的安装包文件名无效。".into());
    }
    if manifest.size_bytes == 0 || manifest.size_bytes > MAX_DESKTOP_UPDATE_BYTES {
        return Err("更新清单中的安装包大小无效。".into());
    }
    if manifest.sha256.len() != 64
        || !manifest
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("更新清单中的 SHA-256 无效。".into());
    }
    Ok(version)
}

fn active_update_context(
    window: &WebviewWindow,
    state: &DesktopState,
) -> Result<(String, Url, String), String> {
    let profile_id = current_profile_id(window, state)?;
    let profile = state.profile(&profile_id)?;
    let endpoint = normalize_endpoint(&profile.endpoint)?;
    let token = decrypt_token(&profile.encrypted_token)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "当前设备的配对凭据不可用，请重新配对。".to_string())?;
    Ok((profile_id, endpoint, token))
}

fn desktop_update_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(10 * 60))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "无法初始化桌面更新连接。".to_string())
}

async fn desktop_update_response_error(response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    if let Ok(payload) = response.json::<serde_json::Value>().await {
        if let Some(detail) = payload.get("detail").and_then(|value| value.as_str()) {
            let detail = detail.trim().chars().take(240).collect::<String>();
            if !detail.is_empty() {
                return detail;
            }
        }
    }
    if status.as_u16() == 401 {
        "当前设备的配对已失效，请重新配对。".into()
    } else {
        fallback.into()
    }
}

async fn fetch_desktop_update_manifest(
    client: &Client,
    endpoint: &Url,
    token: &str,
) -> Result<(DesktopUpdateManifest, Version), String> {
    let url = api_url(endpoint, "/api/v1/desktop/update")?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "检查桌面更新超时，请确认当前设备在线。".to_string()
            } else {
                "无法连接当前设备的桌面更新服务。".to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(desktop_update_response_error(response, "检查桌面更新失败。").await);
    }
    if response.content_length().unwrap_or(0) > 64 * 1024 {
        return Err("桌面更新清单异常。".into());
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "读取桌面更新清单失败。".to_string())?;
    if body.len() > 64 * 1024 {
        return Err("桌面更新清单异常。".into());
    }
    let manifest = serde_json::from_slice::<DesktopUpdateManifest>(&body)
        .map_err(|_| "桌面更新清单格式无效。".to_string())?;
    let version = validate_update_manifest(&manifest)?;
    Ok((manifest, version))
}

fn cached_update_matches(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法读取已下载的桌面安装包。".into()),
    };
    if !metadata.file_type().is_file() || metadata.len() != expected_size {
        return Ok(false);
    }
    let mut file = fs::File::open(path).map_err(|_| "无法读取已下载的桌面安装包。".to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "无法校验已下载的桌面安装包。".to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()) == expected_sha256)
}

fn update_cache_candidates(directory: &Path, manifest: &DesktopUpdateManifest) -> Vec<PathBuf> {
    let original = directory.join(&manifest.filename);
    let stem = manifest
        .filename
        .strip_suffix(".exe")
        .unwrap_or(&manifest.filename);
    let digest_name = format!("{}-{}.exe", stem, &manifest.sha256[..12]);
    vec![original, directory.join(digest_name)]
}

fn find_cached_update(
    directory: &Path,
    manifest: &DesktopUpdateManifest,
) -> Result<Option<PathBuf>, String> {
    for candidate in update_cache_candidates(directory, manifest) {
        if cached_update_matches(&candidate, manifest.size_bytes, &manifest.sha256)? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn publish_downloaded_update(
    temporary: &Path,
    directory: &Path,
    manifest: &DesktopUpdateManifest,
) -> Result<PathBuf, String> {
    let mut candidates = update_cache_candidates(directory, manifest);
    let stem = manifest
        .filename
        .strip_suffix(".exe")
        .unwrap_or(&manifest.filename);
    candidates.push(directory.join(format!(
        "{}-{}-{}.exe",
        stem,
        &manifest.sha256[..12],
        Uuid::new_v4()
    )));
    for candidate in candidates {
        match fs::hard_link(temporary, &candidate) {
            Ok(()) => {
                fs::remove_file(temporary).map_err(|_| "无法完成桌面安装包缓存。".to_string())?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if cached_update_matches(&candidate, manifest.size_bytes, &manifest.sha256)? {
                    let _ = fs::remove_file(temporary);
                    return Ok(candidate);
                }
            }
            Err(_) => return Err("无法保存桌面安装包。".into()),
        }
    }
    Err("无法保存桌面安装包。".into())
}

fn remember_pending_update(
    state: &DesktopState,
    profile_id: String,
    path: PathBuf,
    manifest: &DesktopUpdateManifest,
) -> Result<(), String> {
    *state
        .pending_update
        .lock()
        .map_err(|_| "桌面更新状态暂时不可用。".to_string())? = Some(PendingDesktopUpdate {
        path,
        profile_id,
        version: manifest.version.clone(),
        filename: manifest.filename.clone(),
        size_bytes: manifest.size_bytes,
        sha256: manifest.sha256.clone(),
    });
    Ok(())
}

#[tauri::command]
async fn desktop_update_check(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DesktopUpdateStatus, String> {
    let (_, endpoint, token) = active_update_context(&window, &state)?;
    let client = desktop_update_client()?;
    let (manifest, latest) = fetch_desktop_update_manifest(&client, &endpoint, &token).await?;
    let current = parse_project_version(env!("CARGO_PKG_VERSION"))?;
    let available = compare_project_versions(&latest, &current)? == Ordering::Greater;
    Ok(DesktopUpdateStatus {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        available,
        filename: manifest.filename,
        size_bytes: manifest.size_bytes,
        sha256: manifest.sha256,
    })
}

#[tauri::command]
async fn desktop_update_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DownloadedDesktopUpdate, String> {
    let (profile_id, endpoint, token) = active_update_context(&window, &state)?;
    let client = desktop_update_client()?;
    let (manifest, latest) = fetch_desktop_update_manifest(&client, &endpoint, &token).await?;
    let current = parse_project_version(env!("CARGO_PKG_VERSION"))?;
    if compare_project_versions(&latest, &current)? != Ordering::Greater {
        return Err("当前已是最新桌面版本。".into());
    }

    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法确定桌面更新缓存目录。".to_string())?
        .join("updates");
    fs::create_dir_all(&cache_directory).map_err(|_| "无法创建桌面更新缓存目录。".to_string())?;
    if let Some(path) = find_cached_update(&cache_directory, &manifest)? {
        remember_pending_update(&state, profile_id, path, &manifest)?;
        return Ok(DownloadedDesktopUpdate {
            version: manifest.version,
            filename: manifest.filename,
            size_bytes: manifest.size_bytes,
        });
    }

    let download_url = api_url(
        &endpoint,
        &format!("/api/v1/desktop/update/{}", manifest.filename),
    )?;
    let mut response = client
        .get(download_url)
        .bearer_auth(&token)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "下载桌面安装包超时，请检查网络后重试。".to_string()
            } else {
                "无法下载桌面安装包。".to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(desktop_update_response_error(response, "下载桌面安装包失败。").await);
    }
    if response
        .content_length()
        .is_some_and(|size| size != manifest.size_bytes)
    {
        return Err("桌面安装包大小与更新清单不一致。".into());
    }

    let temporary = cache_directory.join(format!("download-{}.tmp", Uuid::new_v4()));
    let download_result = async {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法创建桌面安装包缓存文件。".to_string())?;
        let mut digest = Sha256::new();
        let mut total = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "下载桌面安装包时连接中断。".to_string())?
        {
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "桌面安装包大小异常。".to_string())?;
            if total > manifest.size_bytes || total > MAX_DESKTOP_UPDATE_BYTES {
                return Err("桌面安装包大小与更新清单不一致。".into());
            }
            file.write_all(&chunk)
                .map_err(|_| "写入桌面安装包失败。".to_string())?;
            digest.update(&chunk);
        }
        file.flush()
            .map_err(|_| "写入桌面安装包失败。".to_string())?;
        file.sync_all()
            .map_err(|_| "写入桌面安装包失败。".to_string())?;
        drop(file);
        if total != manifest.size_bytes {
            return Err("桌面安装包大小与更新清单不一致。".into());
        }
        if format!("{:x}", digest.finalize()) != manifest.sha256 {
            return Err("桌面安装包校验失败，请重新下载。".into());
        }
        publish_downloaded_update(&temporary, &cache_directory, &manifest)
    }
    .await;
    if download_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    let path = download_result?;
    remember_pending_update(&state, profile_id, path, &manifest)?;
    Ok(DownloadedDesktopUpdate {
        version: manifest.version,
        filename: manifest.filename,
        size_bytes: manifest.size_bytes,
    })
}

#[tauri::command]
fn desktop_update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<bool, String> {
    let profile_id = current_profile_id(&window, &state)?;
    let pending = state
        .pending_update
        .lock()
        .map_err(|_| "桌面更新状态暂时不可用。".to_string())?
        .clone()
        .ok_or_else(|| "请先下载并校验桌面更新。".to_string())?;
    if pending.profile_id != profile_id {
        return Err("请从下载此更新的设备页面启动安装。".into());
    }
    if pending.filename != format!("Code-Remote-Desktop-{}-x64.exe", pending.version)
        || !cached_update_matches(&pending.path, pending.size_bytes, &pending.sha256)?
    {
        if let Ok(mut current) = state.pending_update.lock() {
            if current
                .as_ref()
                .is_some_and(|update| update.path == pending.path)
            {
                *current = None;
            }
        }
        return Err("已下载的桌面安装包校验失败，请重新下载。".into());
    }

    #[cfg(windows)]
    {
        std::process::Command::new(&pending.path)
            .arg("/UPDATE")
            .spawn()
            .map_err(|_| "无法启动桌面更新安装程序。".to_string())?;
        if let Ok(mut current) = state.pending_update.lock() {
            *current = None;
        }
        app.exit(0);
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("桌面更新安装仅支持 Windows。".into())
    }
}

#[cfg(windows)]
fn encrypt_token(token: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let mut input_bytes = token.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len() as u32,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 || output.pbData.is_null() {
        return Err("系统凭据加密不可用，无法安全保存配对信息。".into());
    }
    let encrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = STANDARD.encode(encrypted);
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(encoded)
}

#[cfg(not(windows))]
fn encrypt_token(_token: &str) -> Result<String, String> {
    Err("系统凭据加密不可用，无法安全保存配对信息。".into())
}

#[cfg(windows)]
fn decrypt_token(encrypted: &str) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let mut input_bytes = STANDARD.decode(encrypted).ok()?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len() as u32,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 || output.pbData.is_null() {
        return None;
    }
    let plaintext = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let result = String::from_utf8(plaintext.to_vec()).ok();
    unsafe { LocalFree(output.pbData.cast()) };
    result
}

#[cfg(not(windows))]
fn decrypt_token(_encrypted: &str) -> Option<String> {
    None
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let store_path = app.path().app_data_dir()?.join("connections.json");
            let profiles = migrate_legacy_profiles(app.handle(), &store_path);
            app.manage(DesktopState {
                profiles: Mutex::new(profiles),
                window_profiles: Mutex::new(HashMap::new()),
                pending_update: Mutex::new(None),
                store_path,
            });
            make_window(
                app.handle(),
                "main",
                "Code Remote",
                WebviewUrl::App("index.html".into()),
                1320.0,
                860.0,
            )?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<DesktopState>() {
                    if let Ok(mut profiles) = state.window_profiles.lock() {
                        profiles.remove(window.label());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            connection_list,
            connection_pair,
            connection_rename,
            connection_remove,
            connection_activate,
            connection_open_window,
            remote_current_connection,
            remote_get_token,
            remote_save_token,
            remote_clear_token,
            desktop_update_check,
            desktop_update_download,
            desktop_update_install,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Code Remote desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_release_phases_follow_the_documented_order() {
        let dev = parse_project_version("0.115.0-dev.9").unwrap();
        let beta = parse_project_version("0.115.0-beta.1").unwrap();
        let release = parse_project_version("0.115.0").unwrap();

        assert_eq!(
            compare_project_versions(&dev, &beta).unwrap(),
            Ordering::Less
        );
        assert_eq!(
            compare_project_versions(&beta, &release).unwrap(),
            Ordering::Less
        );
        assert_eq!(
            compare_project_versions(&parse_project_version("0.115.0-dev.10").unwrap(), &dev)
                .unwrap(),
            Ordering::Greater
        );
    }

    #[test]
    fn desktop_manifest_requires_exact_filename_size_and_digest() {
        let valid = DesktopUpdateManifest {
            version: "0.115.0-dev.1".into(),
            filename: "Code-Remote-Desktop-0.115.0-dev.1-x64.exe".into(),
            size_bytes: 1024,
            sha256: "a".repeat(64),
        };
        assert!(validate_update_manifest(&valid).is_ok());

        let mut invalid = valid.clone();
        invalid.filename = "another-installer.exe".into();
        assert!(validate_update_manifest(&invalid).is_err());
        invalid = valid.clone();
        invalid.sha256 = "A".repeat(64);
        assert!(validate_update_manifest(&invalid).is_err());
        invalid = valid;
        invalid.size_bytes = 0;
        assert!(validate_update_manifest(&invalid).is_err());
    }
}

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{
    webview::NewWindowResponse, AppHandle, Emitter, Manager, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use unicode_normalization::UnicodeNormalization;
use url::Url;
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
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
    mode: 'desktop', initialProfileId: null,
    listConnections: () => invoke('connection_list'),
    pairConnection: (input) => invoke('connection_pair', { input }),
    renameConnection: (input) => invoke('connection_rename', { input }),
    removeConnection: (input) => invoke('connection_remove', { input }),
    activateConnection: (profileId) => invoke('connection_activate', { profileId }),
    openConnectionWindow: (profileId) => invoke('connection_open_window', { profileId }),
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
    openConnectionWindow: shell.openConnectionWindow,
    onConnectionsChanged: changed,
  };
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
    Url::parse(address).map_err(|_| "无法打开 Code Remote。".to_string())
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
        .initialization_script(BRIDGE_SCRIPT)
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Code Remote desktop");
}

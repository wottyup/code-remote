# Codex Remote Android

Android 客户端使用 Kotlin 和原生 Android View 绘制，不通过 WebView 加载网页。聊天输入框使用 Android 原生 `EditText`，键盘由系统输入法提供。

首次启动时填写电脑网页地址，例如 `http://192.168.15.22:4173`，以及服务启动时显示的配对码。APP 会直接请求网页服务转发的 `/api/v1/pair` 接口；4173 网页端口不提供 `/health` 路径。

## 构建

需要 Java 17、Android SDK（platform 35 和 build-tools 35.0.0）：

```bash
cd android
ANDROID_HOME=/path/to/android-sdk ./gradlew assembleDebug
```

APK 输出在 `app/build/outputs/apk/debug/codex-remote-android-<版本号>-debug.apk`。发布安装包应配置正式签名后再构建 release 版本。

## 离线语音输入

聊天输入框右侧的麦克风按钮使用 sherpa-onnx 在本机识别语音，音频不会上传到电脑或云端。约 25 MB 的中文流式模型会在聊天输入框出现后于后台预加载，首次点击通常会直接开始录音；如果模型仍在加载，点击会在加载完成后自动开始。首次使用会请求麦克风权限，之后点击麦克风即可边说边把文字写入输入框；再次点击或暂停 APP 会结束录音。

模型为 `csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`（Apache-2.0，int8），放在 `app/src/main/assets/offline-asr/`，来源与许可证见该目录下的 `MODEL_NOTICE.txt`。当前模型以中文为主，英文单词识别能力有限，也暂不包含标点模型。

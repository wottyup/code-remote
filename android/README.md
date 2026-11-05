# Code Remote Android

Android 客户端使用 Kotlin 和原生 Android View 绘制，不通过 WebView 加载网页。聊天输入框使用 Android 原生 `EditText`，键盘由系统输入法提供。

首次启动时填写电脑网页地址，例如 `http://192.168.15.22:4173`，以及服务启动时显示的配对码。APP 会直接请求网页服务转发的 `/api/v1/pair` 接口；4173 网页端口不提供 `/health` 路径。

## 构建

需要 Java 17、Android SDK（platform 35 和 build-tools 35.0.0）：

```bash
cd android
ANDROID_HOME=/path/to/android-sdk ./gradlew assembleDebug
```

APK 输出在 `app/build/outputs/apk/debug/code-remote-android-<版本号>-debug.apk`。发布安装包应配置正式签名后再构建 release 版本。

## 本机内网更新

设置页“检查更新”使用当前保存的电脑连接地址及配对凭据，通过 `4173` 网页服务访问 `/api/v1/android/update`，不会连接 GitHub。服务会从项目根目录 `artifacts/` 选择版本最高的 `code-remote-android-<版本号>-debug.apk`；后续打包后须将新文件以这个名字单独复制到该目录，历史包不要覆盖。手机会通过系统下载管理器下载并校验安装包，再打开 Android 系统安装界面。首次使用时可能需要允许 Code Remote 安装未知应用；安装仍由用户在系统界面确认。

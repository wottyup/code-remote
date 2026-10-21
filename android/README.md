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

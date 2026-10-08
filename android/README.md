# Codex Remote Android

这是一个轻量 WebView 外壳。APK 首次启动时填写电脑上的网页地址，例如 `http://192.168.15.22:4173`；检测成功后加载现有网页版，匹配码仍在网页中输入。

## 构建

需要 Java 17、Android SDK（platform 35 和 build-tools 35.0.0）：

```bash
cd android
ANDROID_HOME=/path/to/android-sdk ./gradlew assembleDebug
```

APK 输出在 `app/build/outputs/apk/debug/app-debug.apk`。发布安装包应配置正式签名后再构建 release 版本。

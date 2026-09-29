package com.newhim3.studyhub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String APP_URL = "file:///android_asset/web/index.html";
    private static final String RELEASES_API = "https://api.github.com/repos/newhim3/mayuan-study/releases/latest";
    private WebView webView;
    private DownloadManager downloadManager;
    private final Handler updateHandler = new Handler();
    private Runnable downloadWatcher;
    /**
     * The newest APK this app itself discovered through the GitHub releases API.
     * Only {@link #runUpdateCheck()} writes these, so the page can never hand a
     * download URL to {@link AppBridge#startUpdate()}.
     */
    private String pendingDownloadUrl;
    private int pendingVersion;
    /**
     * Whether the bundled quiz page is the document on screen. Defaults to true
     * so the ordinary startup path keeps the bridge, and turns false only once a
     * foreign document finishes loading, which withholds {@link AppBridge}.
     */
    private volatile boolean bundledPageActive = true;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(247, 248, 250));

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        ProgressBar progress = new ProgressBar(this);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(72, 72);
        progressParams.gravity = android.view.Gravity.CENTER;
        root.addView(progress, progressParams);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // The APK contains the exact gh-pages build used for this release, so
        // the quiz remains usable without network access after installation.
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bundledPageActive = url == null || url.startsWith("file:///android_asset/web/");
                progress.setVisibility(View.GONE);
            }
        });

        // The bundled quiz page asks about updates from its own button, through
        // the "MayuanApp" bridge; nothing here runs at startup.
        webView.addJavascriptInterface(new AppBridge(), "MayuanApp");

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    /**
     * Ask GitHub for the newest signed APK and report the outcome to the page.
     * Runs only when the page's "检查更新" button calls the bridge.
     */
    private void runUpdateCheck() {
        final int current = currentVersionCode();
        Executors.newSingleThreadExecutor().execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(RELEASES_API).openConnection();
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "mayuan-study-android");
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    reportUpdate("error", current, 0, "更新服务暂时不可用");
                    return;
                }

                StringBuilder json = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(connection.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) json.append(line);
                }

                Matcher tag = Pattern.compile("\"tag_name\"\\s*:\\s*\"apk-build-(\\d+)\"").matcher(json);
                Matcher download = Pattern.compile("https://[^,}]*mayuan-study\\.apk").matcher(json);
                if (!tag.find() || !download.find()) {
                    reportUpdate("error", current, 0, "无法解析更新信息");
                    return;
                }

                int latest = Integer.parseInt(tag.group(1));
                if (latest <= current) {
                    pendingDownloadUrl = null;
                    pendingVersion = 0;
                    reportUpdate("latest", current, latest, null);
                    return;
                }
                pendingVersion = latest;
                pendingDownloadUrl = download.group().replace("\\\\/", "/").replace("\"", "");
                reportUpdate("available", current, latest, null);
            } catch (Exception ignored) {
                // 更新检查失败不影响刷题。
                reportUpdate("error", current, 0, "网络连接失败，请稍后重试");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    /** Hand one update-check outcome to the quiz page. */
    private void reportUpdate(String status, int current, int latest, String message) {
        final String payload = "{"
                + "\"status\":\"" + jsonEscape(status) + "\""
                + ",\"current\":" + current
                + ",\"latest\":" + latest
                + ",\"message\":" + (message == null ? "null" : "\"" + jsonEscape(message) + "\"")
                + "}";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "window.__mayuanUpdate && window.__mayuanUpdate(" + payload + ")", null);
            }
        });
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\r", "").replace("\n", "\\n");
    }

    private String currentVersionName() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception ignored) {
            return "";
        }
    }

    private int currentVersionCode() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return (int) info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (Exception ignored) {
            return 0;
        }
    }

    /** The bridge the bundled quiz page uses to ask this app about updates. */
    private class AppBridge {
        /** Current installed version, read synchronously while the page renders. */
        @JavascriptInterface
        public String getVersionInfo() {
            if (!bundledPageActive) return "null";
            return "{\"versionCode\":" + currentVersionCode()
                    + ",\"versionName\":\"" + jsonEscape(currentVersionName()) + "\"}";
        }

        /** Start a manual check; the outcome arrives at window.__mayuanUpdate. */
        @JavascriptInterface
        public void checkForUpdate() {
            if (!bundledPageActive) return;
            runOnUiThread(() -> MainActivity.this.runUpdateCheck());
        }

        /** Download the APK this app most recently discovered, if any. */
        @JavascriptInterface
        public void startUpdate() {
            if (!bundledPageActive) return;
            runOnUiThread(() -> {
                if (pendingDownloadUrl == null) {
                    reportUpdate("error", currentVersionCode(), 0, "没有可用的更新包");
                    return;
                }
                downloadAndInstall(pendingDownloadUrl, pendingVersion);
            });
        }
    }

    private void downloadAndInstall(String downloadUrl, int version) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("需要安装权限")
                    .setMessage("请允许“马原刷题”安装其他应用，返回后再次打开应用即可更新。")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("去设置", (dialog, which) -> {
                        Intent intent = new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    })
                    .show();
            return;
        }

        downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(downloadUrl));
        request.setTitle("马原刷题更新");
        request.setDescription("正在下载 APK #" + version);
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalFilesDir(
                this, Environment.DIRECTORY_DOWNLOADS, "mayuan-study-" + version + ".apk");

        long downloadId = downloadManager.enqueue(request);
        Toast.makeText(this, "已开始下载，完成后会打开安装界面", Toast.LENGTH_LONG).show();

        downloadWatcher = new Runnable() {
            @Override
            public void run() {
                if (downloadManager == null) return;
                try (Cursor cursor = downloadManager.query(
                        new DownloadManager.Query().setFilterById(downloadId))) {
                    if (cursor == null || !cursor.moveToFirst()) return;
                    int status = cursor.getInt(
                            cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        Uri apkUri = downloadManager.getUriForDownloadedFile(downloadId);
                        if (apkUri != null) installApk(apkUri);
                        downloadWatcher = null;
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        Toast.makeText(MainActivity.this, "APK 下载失败，请稍后重试", Toast.LENGTH_LONG).show();
                        downloadWatcher = null;
                    } else {
                        updateHandler.postDelayed(this, 800);
                    }
                }
            }
        };
        updateHandler.post(downloadWatcher);
    }

    private void installApk(Uri apkUri) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (downloadWatcher != null) updateHandler.removeCallbacks(downloadWatcher);
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}

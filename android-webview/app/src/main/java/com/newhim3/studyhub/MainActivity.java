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
    private static final String APP_URL = "https://newhim3.github.io/mayuan-study/";
    private static final String RELEASES_API = "https://api.github.com/repos/newhim3/mayuan-study/releases/latest";
    private WebView webView;
    private DownloadManager downloadManager;
    private final Handler updateHandler = new Handler();
    private Runnable downloadWatcher;

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
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }
        });

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL);
            checkForUpdate();
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void checkForUpdate() {
        Executors.newSingleThreadExecutor().execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(RELEASES_API).openConnection();
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return;

                StringBuilder json = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(connection.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) json.append(line);
                }

                Matcher tag = Pattern.compile("\"tag_name\"\\s*:\\s*\"apk-build-(\\d+)\"")
                Matcher download = Pattern.compile("https://[^,}]*mayuan-study\\.apk").matcher(json);
                        .matcher(json);
                if (!tag.find() || !download.find()) return;

                int latestVersion = Integer.parseInt(tag.group(1));
                if (latestVersion <= BuildConfig.VERSION_CODE) return;
                String downloadUrl = download.group().replace("\\\\/", "/").replace("\"", "");
                runOnUiThread(() -> showUpdateDialog(latestVersion, downloadUrl));
            } catch (Exception ignored) {
                // 更新检查失败不影响刷题。
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void showUpdateDialog(int latestVersion, String downloadUrl) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("发现新版本")
                .setMessage("检测到 APK #" + latestVersion + "，是否下载并安装？")
                .setNegativeButton("稍后再说", null)
                .setPositiveButton("立即更新", (dialog, which) ->
                        downloadAndInstall(downloadUrl, latestVersion))
                .show();
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

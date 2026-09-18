package com.newhim3.studyhub;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

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

                Matcher tag = Pattern.compile("\\"tag_name\\"\\s*:\\s*\\"apk-build-(\\d+)\\"")
                        .matcher(json);
                Matcher download = Pattern.compile("\\"browser_download_url\\"\\s*:\\s*\\"([^\\"]*mayuan-study\\.apk)\\"")
                        .matcher(json);
                if (!tag.find() || !download.find()) return;

                int latestVersion = Integer.parseInt(tag.group(1));
                if (latestVersion <= BuildConfig.VERSION_CODE) return;
                String downloadUrl = download.group(1).replace("\\\\/", "/");
                runOnUiThread(() -> showUpdateDialog(latestVersion, downloadUrl));
            } catch (Exception ignored) {
                // 更新检查失败不影响离线刷题和网页加载。
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void showUpdateDialog(int latestVersion, String downloadUrl) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("发现新版本")
                .setMessage("检测到 APK #"+ latestVersion +"，是否打开下载页面更新？")
                .setNegativeButton("稍后再说", null)
                .setPositiveButton("立即更新", (dialog, which) ->
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl))))
                .show();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}

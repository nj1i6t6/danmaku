# 貢獻指南

感謝你改善彈幕 Overlay。提交前請先閱讀 [LICENSE](LICENSE)、[docs/architecture.md](docs/architecture.md)、[SECURITY.md](SECURITY.md) 與本文件。

## 授權先決條件

本專案是 **source-available、非商用 Network Copyleft**，不是 OSI open source。

提交貢獻即表示：

1. 你有權提交該內容；
2. 你保留自己的著作權，但同意把貢獻依 **Stock Danmaku Non-Commercial Network Copyleft License 1.0** 提供；
3. 你理解修改版散布或向第三人提供網路功能時的完整 source、建置／安裝腳本、修改紀錄及同授權義務；
4. 你的貢獻不會加入與本授權衝突的額外限制。

不要提交你從雇主、客戶、商用專案、未授權資料集或不相容授權來源取得而無權再授權的內容。新增依賴前必須確認來源、版本、授權、install scripts 與鎖定檔。

## 專案方向

目前產品只有三個彈幕使用端：

- Android 原生 Overlay；
- Windows／macOS Tauri Overlay；
- Chrome／Edge Manifest V3 網頁 Overlay。

網站只保留極簡入口，不接受重新加入第四套聊天客戶端、行情搜尋、第三方圖表、內容路由、第三方分析、廣告或遠端程式碼。Desktop 與 Extension 必須共用 `clients/web-overlay/src/core/`，不可複製成兩套漂移實作。

## 安全不變量

貢獻不得破壞：

- Extension 只有一條 background Socket；不能每 tab 連線。
- content script 不持有 owner credential，不建立任意 `window.postMessage` bridge。
- 所有外部文字使用 `textContent`／安全文字節點，不拼接不可信 HTML。
- Origin allowlist 不當成認證；房主管理必須由 server-side credential 驗證。
- 不使用 CDN、remote JavaScript、`eval`、動態 executable code 或多餘 extension 權限。
- Backend 只監聽 loopback；TLS 與 forwarding headers 在可信 reverse proxy 邊界處理。
- 秘密不得進 source、test fixture、log、Toast、console、build output 或公開匯出。

涉及 auth、credential、CORS、Origin、CSP、proxy trust、rate limit、檔案／URL 輸入或 extension 權限的變更，PR 必須附 threat boundary 說明與 executable test。

## 開發與測試

從 repository 根目錄執行：

```bash
npm ci --prefix app
npm test --prefix app
npm audit --prefix app --omit=dev --audit-level=high

npm ci --prefix clients/web-overlay
npm test --prefix clients/web-overlay

node --test desktop/tests/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml

./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug --no-daemon

git diff --check
```

Android 需要 JDK 17 與 SDK 34；若 SDK 不在預設位置，設定 `ANDROID_HOME` 與 `ANDROID_SDK_ROOT`。Windows／macOS installer 需在對應原生 runner 驗證；APK 建置成功不等於真機 Overlay 已驗證。

若修改 build scripts、extension 或公開匯出，另執行對應 `package.json`／`scripts/` 中的 build、E2E、package 與 verify 指令，並在 PR 貼出實際 exit code 與通過／失敗數。不要用 stub 偽裝真實 Socket、service worker restart、跨 tab 或原生平台驗證。

## 建議流程

1. 先搜尋既有 Issue／spec，讓變更保持單一目的。
2. 行為變更先加會失敗的測試，再實作最小完整修正。
3. 更新受影響的 README、架構、權限、隱私、自架或安全文件。
4. 使用 synthetic data、temporary DB、ephemeral port；不碰正式服務。
5. 在 PR 說明動機、架構影響、測試證據、平台限制、隱私／權限變化與回滾方式。

PR 不應包含 build 產物、APK、installer、ZIP、資料庫、log、report、`node_modules`、Gradle/Cargo cache、真實環境檔或 `.hermes` 內容。

## Commit 與修改紀錄

使用清楚、可回溯的 commit。由於 LICENSE 要求修改版提供修改紀錄，對使用者可見或部署行為變更應在 PR／CHANGELOG（若存在）記錄日期、摘要與受影響模組。不要用只有 binary diff 的更新取代 source。

## 安全問題

不要用公開 PR／Issue 揭露未修補漏洞。依 [SECURITY.md](SECURITY.md) 使用私下管道，且不要附真實秘密或第三人資料。

## 行為與內容

討論與測試內容需遵守 [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md)。針對技術決策提出具體證據，避免人身攻擊、騷擾、冒充與無關導流。

本文件與 LICENSE 不是法律意見；對貢獻權利或授權相容性有疑問時，請先取得合格法律意見再提交。

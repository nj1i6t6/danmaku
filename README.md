# 彈幕 Overlay

把同一個聊天室彈幕 Overlay 帶到 Android、Windows／macOS 桌面與 Chrome／Edge 網頁內容區。三端共用房間、彈幕、最近歷史、暱稱、檢舉與外觀設定契約；網站本身只提供極簡介紹、安裝說明與最小服務狀態，不是第四套聊天客戶端。

> **授權定位：source-available，不是 OSI open source。** 本專案禁止商用；非商用可使用與修改。散布修改版，或透過網路向第三人提供修改版功能時，必須公開完整對應原始碼、建置／安裝腳本與修改紀錄，並沿用相同授權。完整條款見 [LICENSE](LICENSE)。

## 產品表面

| 平台 | 形式 | 覆蓋範圍 | 平台限制 |
|---|---|---|---|
| Android | 原生系統 Overlay | 其他 Android App 上方 | 需要「顯示在其他應用程式上層」權限及可見的前景服務通知 |
| Windows／macOS | Tauri 透明置頂視窗 | 桌面應用程式上方 | 受作業系統視窗與輔助功能政策限制 |
| Chrome／Edge | Manifest V3 擴充功能 | 一般 HTTP／HTTPS 網頁內容區 | 無法注入瀏覽器內部頁、商店頁及其他受保護頁面 |
| 網站 | 極簡入口 | 介紹、安裝／下載說明、最小狀態 | 不建立聊天室 Socket、不提供 Web 聊天 UI |
| 後端 | Node.js／Socket.IO | 房間、訊息、最近歷史、檢舉與防濫用 | 僅監聽 loopback，正式環境需 TLS reverse proxy |

## 下載與商店狀態

本 README 不提供尚未存在或尚未驗證的商店／下載連結。請只使用本儲存庫 Releases、專案網站或瀏覽器商店中能核對發布者與校驗資訊的實際項目；若目前沒有項目，請從原始碼建置。第三方重包裝不是官方版本。

## 功能摘要

- 可拖曳懸浮球；單擊展開輸入，雙擊切換彈幕顯示。
- 8 位房間碼、預設房、公開房搜尋、建立／加入／退出及房主管理。
- 最多 100 字彈幕、最多 6 字暱稱、typed ACK、排隊、冷卻、失敗與重試狀態。
- 每個活動房間保留最近 200 則記憶體歷史，支援檢舉。
- Android 為外觀契約基準；Desktop 與 Extension 共用 Web Overlay core。
- 所有伺服器文字以安全文字節點顯示，不把不受信任內容拼成 HTML。

## 瀏覽器權限與隱私

Chrome／Edge 擴充功能在安裝時要求一般 `http://*/*`、`https://*/*` 網站範圍，讓 Overlay 能在安裝後自動出現。這是範圍很廣、瀏覽器會醒目警告的權限。

專案的設計與實作只在頁面建立自己的 Shadow DOM Overlay；不讀取、上傳或分析宿主頁面的正文、表單、輸入框、cookie、localStorage 或網址參數，也不注入遠端 JavaScript。權限的技術能力仍然很強，請在安裝前閱讀 [擴充功能權限說明](docs/extension-permissions.md) 並自行審核 source／build output。

資料處理細節見 [PRIVACY.md](PRIVACY.md)。

## 從原始碼驗證

需求：Node.js 20、npm、Rust（`desktop/src-tauri/Cargo.toml` 要求至少 1.77.2）、Tauri v2 的平台相依套件；Android 需 JDK 17 與 Android SDK 34。

```bash
# Backend
npm ci --prefix app
npm test --prefix app

# Shared Web Overlay / Extension contracts and generated output
npm ci --prefix clients/web-overlay
npm test --prefix clients/web-overlay
DANMAKU_SERVER_URL=http://127.0.0.1:3999 npm run build --prefix clients/web-overlay
npm run verify:extension --prefix clients/web-overlay
npm run package:extension --prefix clients/web-overlay
sha256sum --check release/browser-extension/*.zip.sha256

# Desktop JavaScript 與 Rust
node --test desktop/tests/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml

# Android：若 SDK 不在預設位置，先設定 ANDROID_HOME / ANDROID_SDK_ROOT
DANMAKU_SERVER_URL=https://example.invalid \
  ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug --no-daemon

# Anti-zombie、秘密／binary／symlink 與公開 allowlist
node --test --test-concurrency=1 scripts/tests/*.test.mjs
node scripts/verify-retired-stock.mjs
node scripts/verify-public-tree.mjs --source .
```

可用的 build／package scripts 以各 `package.json`、Gradle wrapper、`Cargo.toml` 與 CI workflow 為正本。完整自架、endpoint 建置與 systemd 步驟見 [docs/self-hosting.md](docs/self-hosting.md)。Windows／macOS 安裝包必須在對應原生 runner 建置與驗證；Linux host 的 Rust 測試成功不等於原生 installer 已簽章或公證。

建立不含私有歷史、交接紀錄、cache、DB、logs、archive 與 release artifact 的本機公開 source tree：

```bash
node scripts/export-public.mjs --output /absolute/path/to/new-or-empty-directory
node scripts/verify-public-tree.mjs --source /absolute/path/to/new-or-empty-directory
```

匯出器只複製明確 allowlist，保留本 LICENSE，並產生相對路徑 SHA-256 manifest；它不初始化 Git、不建立遠端、不 push，也不覆寫非空目錄。

## CI 與候選產物邊界

`.github/workflows/ci.yml` 在 PR／push 執行 Backend、Shared／Extension、Desktop JavaScript、Rust、Android、anti-zombie 與 public-tree gates。另有 GitHub-hosted Windows、macOS、Browser Extension 與 Android workflows，用於對應平台的候選 artifact；不使用部署／服務秘密；Android release workflow 只使用受保護 environment 中的四個 signing secrets。

Workflow 定義通過靜態審查不等於遠端 runner 已成功執行。macOS artifact 明確標示 unsigned；Windows installer、macOS bundle、Android APK 與 genuine unpacked MV3 行為，必須以各自 workflow／裝置的實際綠燈為準。

## 架構與安全邊界

- [架構](docs/architecture.md)
- [自架指南](docs/self-hosting.md)
- [擴充功能權限](docs/extension-permissions.md)
- [安全政策](SECURITY.md)
- [隱私政策](PRIVACY.md)
- [可接受使用政策](ACCEPTABLE-USE.md)
- [服務條款](TERMS-OF-SERVICE.md)
- [商標與非背書政策](TRADEMARK.md)
- [貢獻指南](CONTRIBUTING.md)

重要邊界：Origin allowlist 不是帳號認證；房主管理以伺服器端驗證的 owner credential 為權威。請勿把 credential、token、密碼、私鑰或正式環境檔提交、記錄或放進前端 bundle。

## 授權

本專案自有內容依 **Stock Danmaku Non-Commercial Network Copyleft License 1.0** 提供：

- 允許非商用使用、研究、修改及散布。
- 禁止直接或間接商用；商用需另外取得相關權利人書面授權。
- 修改版一旦散布或向第三人提供網路功能，必須公開完整對應原始碼、建置／安裝腳本及修改紀錄，並沿用同一授權。
- 修改版與自架服務不得冒充官方或暗示原作者背書。
- 第三方元件仍依各自授權條款。

這是自訂的 source-available 授權，不符合 OSI《開放原始碼定義》第 6 項「不得限制使用領域」，因此不得宣稱為 OSI open source。自訂 SPDX 參照為 `LicenseRef-Stock-Danmaku-NC-Network-Copyleft-1.0`。

授權概念與標示方式的權威參考如下；本授權是獨立的自訂條款，**不是** GNU AGPL、OSI 核准授權或 SPDX License List 既有項目：

- OSI《Open Source Definition》第 6 項：不得限制特定使用領域，因此非商用限制不符合該定義：<https://opensource.org/osd>
- GNU AGPL 3.0 第 13 條：遠端網路互動與 Corresponding Source 概念的公開參考：<https://www.gnu.org/licenses/agpl-3.0.html#section13>
- SPDX：不在 SPDX License List 的自訂授權可使用 `LicenseRef-` 識別：<https://spdx.github.io/spdx-spec/v2.3/other-licensing-information-detected/>

**法律審閱提醒：** LICENSE 與本儲存庫的公開政策文件是專案條款，不是對任何人的法律意見。正式公開、營運服務或在特定司法管轄區採用前，請由合格律師審閱。

## 第三方版本

Fork 可誠實寫「基於 Stock Danmaku」，但必須清楚改名、標示修改並遵守 [TRADEMARK.md](TRADEMARK.md)。原作者不為第三方的修改、內容、部署、違法行為、安全事件或損失負責。

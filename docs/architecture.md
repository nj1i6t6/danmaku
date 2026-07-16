# 架構與信任邊界

## 1. 產品邊界

彈幕 Overlay 有三個使用端，後端只有一套房間協定；網站不是聊天客戶端。

```text
Android Overlay ───────────────┐
Tauri Desktop Overlay ─────────┼── HTTPS/WSS reverse proxy ── 127.0.0.1:3999 Node/Socket.IO
Chrome/Edge MV3 background ────┘                                  │
                                                                  └── SQLite（房間 metadata／檢舉）
Static landing ── GET /、GET /healthz（不初始化聊天室 Socket）
```

| 表面 | 角色 | 主要信任邊界 |
|---|---|---|
| Android | `TYPE_APPLICATION_OVERLAY` + 前景服務 | Android 權限、app private storage、Android Keystore |
| Windows／macOS | Tauri 透明置頂視窗 | WebView／Tauri IPC、原生 click-through、OS keyring |
| Chrome／Edge | MV3 content + background + popup/options | 宿主頁、isolated world、Shadow DOM、runtime messaging、extension storage |
| Backend | Express + Socket.IO + SQLite | reverse proxy、Origin、schema、rate limit、owner credential、DB filesystem |
| Landing | 靜態入口與最小狀態 | CSP、同源靜態資產、無第三方 script／analytics |

## 2. 共同行為契約

三端共同支援懸浮球、房間摘要、8 位房間碼、最多 100 字彈幕、最多 6 字暱稱、最近 200 則歷史、檢舉、房間建立／加入／管理／退出，以及一致的外觀 defaults／ranges。

Android 是外觀基準。Desktop 與 Extension 共用 `clients/web-overlay/src/core/` 的設定、send state、房間模型、安全渲染與 UI controller，再由 platform adapter 提供安全儲存、Socket、視窗與 DOM 能力。禁止複製兩套 core 後各自演進。

恢復外觀預設不清除 clientId、暱稱、房間、joined rooms 或 owner credential。

## 3. Backend

`app/server.js` 建立 Express、HTTP server 與 Socket.IO，固定監聽 `127.0.0.1`。正式公開流量必須經過同機或受控的 TLS reverse proxy。

### 3.1 資料

- SQLite 以 WAL 模式保存房間 metadata、房間 code tombstone、owner credential 雜湊、加鹽 scrypt 房間密碼衍生值、建立配額用 client/IP 雜湊，以及檢舉紀錄。
- 一般彈幕不寫入持久訊息歷史；每個活動房間以有界 ring buffer 保存最近 200 則。
- 檢舉會把被檢舉訊息文字、理由、房間／message ID 與假名化識別寫入 DB。
- owner credential 明文只在建立時回給可信客戶端；伺服器以雜湊做 constant-time 驗證。

### 3.2 防濫用

邊界包括：payload allowlist/schema、字數與 byte limits、內容清理、安全顏色／暱稱、per-client rate limit、per-IP 連線／檢舉限制、全站及房間容量、公平有界 queue、KDF concurrency、重複檢查與 typed ACK。這些是濫用控制，不是帳號認證或內容安全保證。

### 3.3 HTTP

- `/`：極簡靜態入口，不建立 Socket。
- `/healthz`：固定最小狀態與 `Cache-Control: no-store`。
- Security headers：CSP、HSTS（只在可信 HTTPS forwarding boundary 生效）、Permissions-Policy、`nosniff`、frame denial。
- 未定義的 HTTP route 以一致的最小 JSON 404 回應。

## 4. Reverse proxy 與 Origin

```text
Internet
  │ TLS :443
  ▼
Trusted reverse proxy
  │ sanitized X-Forwarded-Proto / CF-Connecting-IP
  ▼
127.0.0.1:<PORT> only
```

`TRUST_CLOUDFLARE_PROXY=1` 只有在立即 TCP peer 是 loopback 時才會使用 forwarding headers；proxy 還必須覆寫外部傳入值。若 proxy 不可信或未清理 header，保持 `0`。

Origin allowlist 接受已配置的 Web／Tauri／Extension 測試或正式 origin，並允許無 Origin 的原生客戶端。**Origin 不是身分認證。** `chrome-extension://` ID 可公開；權威仍是 schema、rate limit 與 owner credential。

## 5. Chrome／Edge MV3

```text
background service worker（唯一網路／credential authority）
├── single Socket.IO client + reconnect
├── persistent non-secret state
├── trusted credential storage
├── typed ACK / generation state
└── sanitized broadcast
       │ chrome.runtime message schema
       ▼
content script（top frame）
└── Shadow DOM host
    ├── danmaku stage
    ├── floating ball / panel / dialogs
    └── safe text rendering
```

- 宣告式 content script 匹配一般 HTTP／HTTPS。
- content 只傳送 allowlisted 結構化命令，不讀取 credential。
- 不使用頁面 `window.postMessage` bridge，不讀宿主資料。
- hidden tab 停止動畫與高頻 DOM 更新，只維持 bounded state。
- service worker 可隨時重啟；初始化與 listener 必須 idempotent，storage 損壞須逐欄 clamp/fallback。
- Socket client、本地字型／圖示與全部 executable code 隨 package 提供，不從 CDN 載入。

詳見 [extension-permissions.md](extension-permissions.md)。

## 6. Desktop Tauri

Tauri WebView 使用 shared core + Desktop adapter：

- 透明、無邊框、always-on-top overlay；
- 只有互動區域接收 pointer，其他區域使用原生 click-through；
- Wayland 無法可靠取得 global cursor 時採 fail-open，保持視窗可互動，避免 Overlay 永久鎖死；
- owner credential 與穩定 client ID 透過 allowlisted Tauri commands 存入 OS keyring，不進一般 Web storage；
- CSP 的 `connect-src` 只允許 IPC 與建置時指定 endpoint。

Desktop bundle 必須在 Windows／macOS 原生 runner 驗證。未簽章、未 notarize 的 artifact 必須如實標示。

## 7. Android

Android 使用 Kotlin 原生 UI：

- `SYSTEM_ALERT_WINDOW` 建立 `TYPE_APPLICATION_OVERLAY`；
- 前景服務與持續通知讓使用者知道 Overlay 正在執行；
- service `exported=false`；
- 一般設定在 app private SharedPreferences；
- owner credential 以 Android Keystore AES-GCM 金鑰加密後存入 private preferences；
- Socket auth 明確使用 `platform: android` 與穩定 clientId。

Android build 使用 JDK 17、compile/target SDK 34、min SDK 26。APK 建置不等同真機權限、IME、拖曳與多 App Overlay 已驗證。

## 8. Landing

Landing 使用系統字型、本地 CSS／圖示與最小 status script。它不載入 Socket.IO、第三方圖表、外部字型服務、第三方分析或遠端 script，也不保存聊天室 owner session。退役的 PWA source 已自 active tree 移除。

只有實際存在且可驗證的 artifact／商店 URL 才能顯示；不能使用假下載按鈕。

## 9. 秘密與儲存矩陣

| 資料 | Server | Android | Desktop | Extension content | Extension background |
|---|---|---|---|---|---|
| clientId | auth／rate state；建立 quota 保存雜湊 | private preferences | 本機狀態／keyring（依 adapter） | sanitized state 可見 | storage authority |
| owner credential | 只保存雜湊 | Keystore 加密 backing | OS keyring | **不可見** | trusted context only |
| 房間密碼 | scrypt salt + digest | 僅操作時記憶體 | 僅操作時記憶體 | 僅表單命令，不持久化 | 僅轉送操作，不記錄 |
| 彈幕 | 活動房間最近 200 則記憶體；被檢舉內容進 DB | 畫面／本機狀態 | 畫面／本機狀態 | 畫面／bounded history | bounded sync state |
| 宿主頁內容 | 不接收 | 不適用 | 不適用 | **不得讀取／傳送** | 不接收 |

秘密不得出現在 console、Toast、analytics、error payload、diagnostics、source、CI log 或公開匯出。

## 10. 建置與供應鏈

- Node packages 使用 lockfile 與 `npm ci`。
- Android 使用 repository 內 Gradle wrapper；JDK 17／SDK 34。
- Rust 版本下限由 `Cargo.toml` 宣告，依賴由 `Cargo.lock` 固定。
- Extension bundle 需檢查 manifest、member allowlist、remote code、sourcemap、placeholder、secret 與可攜式 checksum。
- 公開匯出使用 explicit allowlist，排除 `.git` 私有歷史、工作／交接狀態、DB、logs、reports、artifacts、generated output、build cache、研究／archive 與 credential；sanitized manifest 綁定相對路徑、大小、SHA-256 與 executable bit。
- Public verifier 拒絕額外檔案、symlink escape、credential URL、private key、token-like secret、release binary、manifest drift 與退役產品殘留。
- CI 分為通用 PR／push gate，以及 Windows、unsigned macOS、Extension、Android 的 GitHub-hosted artifact workflows；不使用部署／服務秘密；Android release workflow 只使用受保護 environment 中的四個 signing secrets。
- CI 只能驗證它實際執行的平台；不得把 Linux host build、YAML 靜態解析或 unsigned bundle 當成 Windows／macOS 簽章／公證證明。

## 11. 架構不變量

1. 三端共同能力只有平台限制可造成差異。
2. Website 不成為第四套聊天客戶端。
3. Extension 全部分頁只有一條背景 Socket。
4. content script 與宿主頁永遠拿不到 owner credential。
5. 外部字串只以安全文字渲染。
6. Endpoint 是明確 build／deploy 設定；公開 source 不無聲連官方服務。
7. Origin 不是 auth，公開 extension ID 不是秘密。
8. 正式服務只從 loopback backend 經 TLS proxy 公開。
9. 不恢復已退役的行情、搜尋、第三方圖表或內容路由功能。
10. 修改版不得冒充官方，且受 LICENSE 的網路 source 公開義務拘束。

## 12. 官方技術參考

- Chrome Content Scripts：<https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- Chrome Permissions：<https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- Chrome Service Worker Lifecycle：<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome Storage：<https://developer.chrome.com/docs/extensions/reference/api/storage>
- Tauri v2 Development／Distribution：<https://v2.tauri.app/develop/>、<https://v2.tauri.app/distribute/>
- Android `SYSTEM_ALERT_WINDOW`：<https://developer.android.com/reference/android/Manifest.permission#SYSTEM_ALERT_WINDOW>
- Android Foreground Services：<https://developer.android.com/develop/background-work/services/fgs>

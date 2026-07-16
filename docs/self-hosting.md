# 自架指南

本指南以 repository 內的 `app/package.json`、`clients/web-overlay/package.json`、Android Gradle wrapper、`desktop/src-tauri/Cargo.toml`、Tauri config 與 `deploy/stock-danmaku.service` 為命令正本。不要從私人正式主機複製環境檔、資料庫、key、token 或 service override。

> 自架與修改版受 [LICENSE](../LICENSE) 約束：禁止商用。修改版若散布或向第三人提供網路功能，必須公開正在執行版本的完整對應原始碼、建置／安裝腳本與修改紀錄，沿用同一授權，並依 [TRADEMARK.md](../TRADEMARK.md) 清楚標示非官方。

## 1. 前置需求

### Backend

- Linux（systemd 範例）；
- Node.js 20 與 npm；
- 可安裝 `better-sqlite3` 的平台工具鏈／預編譯套件；
- 同機或受控 reverse proxy，提供有效 HTTPS/WSS。

### 客戶端

- Shared Web Overlay／Extension：Node.js 20、npm；瀏覽器 E2E 依 package lock 安裝 Playwright。
- Desktop：Rust 至少 1.85.0、Tauri v2 平台 prerequisite；bundle 必須在目標 Windows／macOS 環境驗證。
- Android：JDK 17、Android SDK platform 34／build-tools 34，使用 repository 內 `android/gradlew`。

## 2. 先跑 source tests

從已取得的 source tree 根目錄執行：

```bash
npm ci --prefix app
npm test --prefix app
npm audit --prefix app --omit=dev --audit-level=high

npm ci --prefix clients/web-overlay
npm test --prefix clients/web-overlay

node --test desktop/tests/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml

DANMAKU_SERVER_URL=https://example.invalid \
  ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug --no-daemon
```

如果 Android SDK 不在預設位置：

```bash
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_SDK_ROOT=/path/to/android-sdk
DANMAKU_SERVER_URL=https://example.invalid \
  ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug --no-daemon
```

不要把 APK build、Rust test 或 Linux host compile 說成 Windows／macOS installer、Android 真機或商店審核已通過。

## 3. Backend 本機啟動

`app/server.js` 固定只監聽 `127.0.0.1`。本機開發可使用：

```bash
PORT=3999 \
DB_PATH=/tmp/stock-danmaku-dev.db \
ENFORCE_HTTPS=0 \
TRUST_CLOUDFLARE_PROXY=0 \
npm start --prefix app
```

另一個 shell 驗證：

```bash
curl --fail --silent http://127.0.0.1:3999/healthz
```

預期最小回應是 `{"status":"ok"}`。`/healthz` 不應包含版本、PID、DB、記憶體、房間數或部署資訊。

`/tmp` DB 僅供開發。正式 DB 應置於 systemd `StateDirectory`（本範例為 `/var/lib/stock-danmaku/`），權限只給 service account。

## 4. 正式環境變數

以 repository 的 `.env.example` 為起點，另建 root 擁有、mode `0600` 的 `/etc/stock-danmaku/stock-danmaku.env`。以下都是 placeholder／範例，不能直接當正式識別或秘密：

```dotenv
NODE_ENV=production
PORT=3999
DB_PATH=/var/lib/stock-danmaku/reports.db
MAX_CONNECTIONS_PER_IP=100
ALLOW_DEV_ORIGINS=0

ENFORCE_HTTPS=1
PUBLIC_ORIGIN=https://danmaku.example.org

# 只有立即 reverse proxy 在 loopback，且會覆寫外部 forwarding headers 時才設 1。
TRUST_CLOUDFLARE_PROXY=1

# 若目前版本支援 extension origin 設定，列出你自己 build 的 ID；ID 是公開識別，不是秘密。
# 下列 32 個 a 只是格式範例，不是官方 ID。
EXTENSION_ORIGINS=chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

規則：

- `PUBLIC_ORIGIN` 必須是純 HTTPS origin，不含帳密、path、query 或 fragment。
- `ALLOW_DEV_ORIGINS=1` 只供本機 browser development；正式環境必須保持 `0`，避免公開服務接受 localhost 網頁 Origin。
- 不要把 `.env` 放進 Git、frontend bundle、ZIP、APK、Issue 或 CI log。
- `TRUST_CLOUDFLARE_PROXY=1` 不代表可以相信 Internet 傳入 header；立即 peer 必須是 loopback，proxy 必須覆寫 `X-Forwarded-Proto` 與 `CF-Connecting-IP`。
- Extension Origin allowlist 用於瀏覽器邊界，不是登入。owner credential 才是房主管理能力。

## 5. systemd 目錄布局

repository 的 unit 預期：

- 使用者／群組：`stock-danmaku`；
- `WorkingDirectory=/opt/stock-danmaku/current`；
- `ExecStart=/usr/bin/node server.js`；
- 環境檔：`/etc/stock-danmaku/stock-danmaku.env`；
- 可寫狀態：`/var/lib/stock-danmaku`（由 `StateDirectory=stock-danmaku` 建立）。

因此 release 目錄根層必須是 `app/` 內容，而不是 repository 根層。以下以非秘密 release 名稱示範；先逐行審查再執行：

```bash
export RELEASE_ID=local-20260715
if ! getent passwd stock-danmaku >/dev/null; then
  sudo useradd --system --home-dir /var/lib/stock-danmaku --shell /usr/sbin/nologin stock-danmaku
fi
sudo install -d -o stock-danmaku -g stock-danmaku -m 0700 /var/lib/stock-danmaku
sudo install -d -o root -g root -m 0755 /opt/stock-danmaku/releases
sudo install -d -o root -g root -m 0755 "/opt/stock-danmaku/releases/${RELEASE_ID}"
git archive HEAD:app | sudo tar -x -C "/opt/stock-danmaku/releases/${RELEASE_ID}"
sudo chown -R stock-danmaku:stock-danmaku "/opt/stock-danmaku/releases/${RELEASE_ID}"
sudo -u stock-danmaku npm ci --omit=dev --prefix "/opt/stock-danmaku/releases/${RELEASE_ID}"
sudo chown -R root:root "/opt/stock-danmaku/releases/${RELEASE_ID}"
sudo ln -sfnT "/opt/stock-danmaku/releases/${RELEASE_ID}" /opt/stock-danmaku/current
sudo install -o root -g root -m 0644 deploy/stock-danmaku.service /etc/systemd/system/stock-danmaku.service
sudo systemctl daemon-reload
sudo systemctl enable --now stock-danmaku.service
```

`git archive HEAD:app` 刻意只部署已提交的 backend source，不複製工作目錄內的 `node_modules`、資料庫或未追蹤檔案。切換 symlink 前應保留上一個 release 路徑作 rollback，且只部署已驗證、乾淨 commit。

Fork／自架網域在部署前必須把 `app/public/robots.txt` 與 `app/public/sitemap.xml` 內的官方 `danmaku.kolvid.app` 改成自己的 `PUBLIC_ORIGIN`；這兩個檔案是純靜態 SEO metadata，server 不會在 runtime 代換。官方部署則保留 repository 內的官方網域。

驗證：

```bash
systemctl show stock-danmaku.service \
  --property=User,Group,WorkingDirectory,ExecStart,ActiveState,SubState --no-pager
curl --fail --silent http://127.0.0.1:3999/healthz
```

不要把 `systemctl cat`、`systemctl show --property=Environment` 或環境檔內容貼到公開 Issue，因為 override 可能含秘密。

## 6. Reverse proxy

公開 80 應固定 308 導向 HTTPS；443 終止 TLS，並代理 HTTP 與 WebSocket 至 `127.0.0.1:3999`。proxy 必須：

- 覆寫而非追加 `X-Forwarded-Proto`；
- 覆寫／清除外部傳入 `CF-Connecting-IP`；
- 正確處理 WebSocket Upgrade；
- 不對外暴露 backend loopback port；
- 限制 request/body/timeouts 並保護 log；
- 保留必要 `Origin` 讓 backend 執行 allowlist。

Nginx location 核心範例（TLS certificate、完整 server block 與 rate limits 依你的環境設定）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3999;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header CF-Connecting-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

`$connection_upgrade` 通常需在 `http {}` 先以 `map $http_upgrade $connection_upgrade` 定義。若前面另有 CDN，只能在驗證 CDN peer 並清理 header 後傳遞真實 client IP；無法保證時寧可使用 proxy peer IP，代價是 rate limit 較粗糙。

由公開端驗證 HTTPS、WSS、308、HSTS 與最小 health response；不要只測 loopback 後就宣稱 TLS 正確。

## 7. Extension 自架 build

Endpoint 必須在 build 時固定，不接受 runtime 任意 URL。以實際 `clients/web-overlay/package.json` scripts 為準；支援完整 build scripts 的版本使用：

```bash
npm ci --prefix clients/web-overlay
DANMAKU_SERVER_URL=https://danmaku.example.org \
  npm run build:extension --prefix clients/web-overlay
npm run verify:extension --prefix clients/web-overlay
npm run package:extension --prefix clients/web-overlay
```

載入產物前，檢查 manifest 權限與 CSP。以 Chrome／Edge 的「Load unpacked」載入 build output，記下瀏覽器顯示的 extension ID，再把**你自己的** `chrome-extension://<32-letter-id>` 加入 backend `EXTENSION_ORIGINS` 並重啟服務。ID 可公開；不要把產生 ID 的私鑰提交或輸出。

如果目前 `package.json` 沒有上述 script，表示該 source snapshot 尚未包含可重建 extension pipeline；不要手工拼湊 ZIP或假稱已建置，應使用包含 scripts／lockfile／tests 的完整版本。

詳見 [extension-permissions.md](extension-permissions.md)。

## 8. Desktop 自架 build

先用 shared build 產生 Desktop frontend，再由 Tauri 在目標平台建置：

```bash
npm ci --prefix clients/web-overlay
node --test desktop/tests/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked
DANMAKU_SERVER_URL=https://danmaku.example.org \
  npm run tauri:build --prefix clients/web-overlay
```

如果 snapshot 尚未提供 `build:desktop`，請勿沿用 hard-coded 官方 endpoint 發布自架版；先使用具備 build-time endpoint pipeline 的完整 source。Tauri CSP 的 `connect-src` 必須只包含你的 HTTPS/WSS endpoint 與必要 IPC。

Windows／macOS 要使用自己的 bundle identifier、圖示、簽章與發布名稱，清楚標示非官方。簽章與 notarization 不是本 repository 可代替你的步驟。

## 9. Android 自架 build

Android endpoint 是 compile-time 設定；`DANMAKU_SERVER_URL` 環境變數或 `-PdanmakuServerUrl=...` 會產生 `BuildConfig.DANMAKU_SERVER_URL`。遠端 endpoint 必須是沒有帳密、path、query 或 fragment 的 HTTPS origin；未設定時會 fail closed 到 `https://example.invalid`，不會無聲連官方服務。然後：

```bash
DANMAKU_SERVER_URL=https://danmaku.example.org \
  ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug --no-daemon

# 等價的 Gradle property 形式
./android/gradlew -p android \
  -PdanmakuServerUrl=https://danmaku.example.org \
  testDebugUnitTest lintDebug assembleDebug --no-daemon
```

正式發布應配置自己的 `applicationId`、名稱、圖示與簽章，並在目標 Android 版本真機驗證 Overlay permission、前景服務通知、IME、拖曳、重啟與清除資料行為。不要把 debug APK 當成正式簽章 artifact。

## 10. 乾淨公開 source 匯出

當授權義務要求提供對應 source，使用 repository 內的 allowlist 匯出器，不要直接複製 dirty workspace：

```bash
node --test --test-concurrency=1 scripts/tests/*.test.mjs
node scripts/verify-public-tree.mjs --source .
node scripts/export-public.mjs --output /absolute/path/to/new-or-empty-directory
node scripts/verify-public-tree.mjs --source /absolute/path/to/new-or-empty-directory
```

輸出目錄必須不存在或為空；工具不會覆寫既有資料。匯出內容保留自訂 LICENSE 與可重建 source，排除私有 Git history、交接文件、`.hermes`、cache、DB、logs、reports、raw test results、研究／archive、APK／installer／ZIP 與 release 成品。`PUBLIC-SOURCE-MANIFEST.json` 只含相對路徑、size、SHA-256 及必要 executable bit。匯出後會再次執行秘密、含帳密 URL、private key、binary、symlink 與退役功能掃描。

此命令只建立本機目錄；不會 `git init`、建立 repository、push、發布或部署。正式對外提供前仍須核對實際修改紀錄、授權、隱私與安全聯絡資訊。

## 11. CI 與原生 artifact 邊界

Repository 提供五份 GitHub-hosted workflows：一般 CI、Windows、unsigned macOS、Browser Extension 與 Android。它們只做 tests、build、verification 與 artifact upload，不執行正式部署或商店提交，也不使用部署／服務秘密；Android release workflow 只使用受保護 environment 中的四個 signing secrets。第一次在 fork／公開 repository 啟用前，仍需逐份審閱 action 版本、最小權限與實際 runner log。

Windows `.exe`／`.msi`、macOS `.app`／`.dmg`、Android APK 與 genuine unpacked MV3 行為，只有對應 workflow／裝置實際成功才算通過。YAML 可解析、Linux tests 成功或 unsigned bundle 產出，不能替代簽章、公證、真機或商店驗證。

## 12. 資料、備份與復原

SQLite 使用 WAL；備份不能只在寫入期間任意複製主 `.db` 而忽略 `-wal`。請使用 SQLite backup API／經驗證的停機備份流程，並限制備份權限。至少驗證：

```bash
sqlite3 /var/lib/stock-danmaku/reports.db 'PRAGMA quick_check;'
```

備份可能含房間 metadata、雜湊識別與檢舉內容，仍屬敏感資料。加密、保留、刪除與存取稽核由自架者負責。

## 13. 更新與 rollback

1. 在新 release 目錄執行 `npm ci --omit=dev` 與完整 tests。
2. 檢查 source／lockfile／LICENSE／修改紀錄和秘密掃描。
3. 記錄目前 `current` 指向；原子切換至新 release。
4. restart，驗證 systemd、loopback、HTTPS/WSS、Origin、health 與 typed ACK。
5. 失敗時切回前一 release、restart 並重跑舊版 gate。

不要從 dirty working tree部署，不要讓 rollback 只回退 Git 而遺漏 DB／環境／reverse proxy 狀態。

## 14. 自架責任與法律提醒

自架者是獨立營運者，必須提供自己的 Terms、Privacy、Acceptable Use、security contact、資料保留與法令遵循說明。不得冒充官方或暗示背書。原作者在法律允許最大範圍內不對第三方內容、侵權、違法使用、修改、部署或損失負責。

這份指南不是法律意見，也不是完整 production security review。公開服務前請由合格的系統安全人員與律師依實際架構審閱。

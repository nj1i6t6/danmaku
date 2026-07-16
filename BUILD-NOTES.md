# 彈幕 Overlay — 建置備註

> 架構以 `docs/architecture.md` 為正本；實際命令以 lockfile、Gradle wrapper、Cargo manifest、package scripts 與 CI workflow 為準。
> 最後整理：2026-07-16

## 工具鏈

- Backend／Shared／Extension：Node.js 20 與 npm lockfile。
- Desktop：Rust 至少 1.85.0、Tauri v2，以及目標作業系統的原生依賴。
- Android：JDK 17、Android SDK 34、repository 內 Gradle wrapper。
- Browser QA：Chromium／Chrome 或 Edge；unpacked MV3 測試需要允許載入本機擴充功能的 runner。

## 常用命令

```bash
npm ci --prefix app
npm test --prefix app

npm ci --prefix clients/web-overlay
npm test --prefix clients/web-overlay
DANMAKU_SERVER_URL=https://example.invalid npm run build:extension --prefix clients/web-overlay
npm run test:e2e --prefix clients/web-overlay
npm run package:extension --prefix clients/web-overlay

node --test desktop/tests/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --locked
DANMAKU_SERVER_URL=https://example.invalid \
  ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug --no-daemon

node --test --test-concurrency=1 scripts/tests/*.test.mjs
node scripts/verify-retired-stock.mjs
node scripts/verify-public-tree.mjs --source .
node scripts/export-public.mjs --output /absolute/path/to/new-or-empty-directory
node /absolute/path/to/new-or-empty-directory/scripts/verify-public-tree.mjs \
  --source /absolute/path/to/new-or-empty-directory
```

## 重要陷阱

- Endpoint 必須在 build／deploy 時明確提供；公開 source build 不得無聲連到官方服務。
- `desktop/frontend/generated/` 與 Extension `dist/` 只能由正式 build script 重建，不手改 generated output。
- Browser Extension package 只能包含 allowlist members，且 ZIP 必須解壓後再驗證並產生可攜式 SHA-256。
- 公開匯出只能寫入 source tree 外的新目錄或空目錄；不刪除、不覆蓋，輸出必須再以 manifest mode 驗證。
- GitHub workflows 只定義 verification／build；只有實際 runner 綠燈才能證明原生、Android 或 genuine MV3 gate 通過。
- MV3 service worker 會被瀏覽器回收；初始化、listener、storage restore 與 Socket reconnect 必須可重入。
- Chromium enterprise policy 可能禁止 unpacked extension 或本機 URL。遇到 policy 阻擋應記為 runner limitation，不以注入腳本測試冒充完整 MV3 lifecycle。
- Android wrapper 若無法取得指定 Gradle distribution，unit／lint／APK gate 必須交給有完整離線 cache 或網路的 runner。
- Windows installer、macOS bundle／簽章／公證只能在對應原生 runner 驗證。
- snapshot 若沒有 `.git`，Git-only gate 應明確標記 unavailable，改做 deterministic tree、checksum、secret、symlink、package 與 generated-output verification。

## 交付紀律

- 不在 source、build、log 或 artifact 放入 credential、token、私鑰、正式環境檔或第三人資料。
- 每個 Task 記錄 RED／GREEN、命令、exit code、pass/fail、review 與 deferred gate。
- 原生 gate 未執行時只能標記「程式／靜態審查完成，待平台驗證」，不能標成全綠。

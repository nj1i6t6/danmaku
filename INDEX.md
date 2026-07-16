# 彈幕 Overlay — 專案索引

本索引描述目前產品與可建置來源。已退出的研究與舊方向只保留在 `archive/`，不屬於 active source、build、package 或公開匯出。

## 目前產品

- `app/`：Node.js／Express／Socket.IO 後端與極簡靜態入口。
- `clients/web-overlay/`：Desktop 與 Browser Extension 共用的 Overlay core，以及 Manifest V3 擴充功能來源、測試、build 與 package scripts。
- `desktop/`：Tauri v2 桌面 adapter、透明置頂視窗、OS credential 與 click-through 邊界。
- `android/`：Kotlin 原生系統 Overlay、前景服務、房間 UI 與 Android Keystore credential storage。
- `load-tests/`：獨立埠的負載與延遲測試工具。
- `release/browser-extension/`：由正式 package script 產生的擴充功能 ZIP 與 SHA-256。

## 主要目錄

```text
app/
  public/                 極簡入口；只有本地 HTML/CSS/icons/status script
  protection/             內容過濾、限流與濫用控制
  rooms/                  房間、credential、queue、retention 與 validation
  tests/                  Backend 單元／整合測試
clients/web-overlay/
  src/core/                Desktop／Extension 共用 UI 與狀態契約
  src/extension/           MV3 background、content、popup、options、storage
  scripts/                 build、verify、package
  tests/                   shared contracts 與 browser tests
desktop/
  frontend/generated/     正式 shared build output
  frontend/js/            Desktop platform adapter
  src-tauri/              Rust／Tauri 原生能力
  tests/                   Desktop、跨端 contract 與靜態安全測試
android/                   Gradle Android App
docs/                     架構、自架、權限與核准規格
scripts/                  repository verifier 與公開匯出工具
archive/                  私有遷移／歷史材料；不進 build 或 public export
```

## 權威文件

1. `README.md`：產品表面、建置入口與授權摘要。
2. `docs/architecture.md`：目前架構、房間契約與信任邊界。
3. `docs/extension-permissions.md`：瀏覽器 Extension 權限與資料邊界。
4. `docs/self-hosting.md`：自架、endpoint 注入、部署與公開 source 流程。
5. `PRIVACY.md`、`SECURITY.md`、`LICENSE`：資料、安全與授權邊界。
6. `CONTRIBUTING.md`、`BUILD-NOTES.md`：貢獻與可重建驗證入口。

## 正式驗證入口

```bash
npm test --prefix app
npm test --prefix clients/web-overlay
npm run build:extension --prefix clients/web-overlay
npm run test:e2e --prefix clients/web-overlay
npm run package:extension --prefix clients/web-overlay
node --test desktop/tests/*.test.mjs
node scripts/verify-retired-stock.mjs
```

Android、Rust、Windows 與 macOS 的原生 gate 必須在具備對應 SDK／runner 的環境執行；不能由 Linux 靜態檢查冒充通過。

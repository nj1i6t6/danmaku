# 安全政策

## 支援範圍

安全修正以目前預設分支及最新正式發布版本為優先。過期 artifact、第三方 fork、自架環境、未簽章重包裝與自行修改版本不保證獲得修正；但若問題也存在於本專案目前 source，仍歡迎私下通報。

## 私下通報漏洞

請勿在公開 Issue、聊天室、彈幕或社群貼出可利用細節、秘密或個人資料。

1. 優先使用此 repository 的 **Security → Advisories → Report a vulnerability** 私下通報功能。
2. 若該功能不可用，使用專案維護者在 repository profile 或官方網站明確列出的非公開聯絡管道。
3. 若找不到任何私下管道，可開一個不含細節的公開 Issue，僅寫「需要安全聯絡方式」；待移轉到私下管道後再提供技術內容。

通報請包含：

- 受影響元件與版本／commit；
- 可重現的最小步驟與預期影響；
- 是否需要特殊權限、使用者互動或特定平台；
- 已採取的安全測試範圍；
- 建議修正（若有）；
- 您希望使用的姓名或匿名方式。

不要附上真實 owner credential、token、cookie、私鑰、房間密碼、第三人內容或正式資料庫。請用 synthetic input 與 placeholder。

## 回應目標

這些是目標，不是保證：7 日內確認收到、14 日內完成初步分級，並盡可能在 90 日內協調修正與揭露。若修正依賴商店審核、作業系統更新或大規模架構變更，時程可能延長；維護者會在私下管道更新狀態。

## 優先處理項目

- owner credential、房間密碼、token 或個人資料外洩；
- 擴充功能 content script 與 background 邊界繞過；
- 宿主網頁觸發任意 extension API、遠端程式碼或權限提升；
- XSS、DOM 注入、CSP 繞過；
- Origin／proxy trust 錯誤導致跨站濫用或 IP 邊界失效；
- Socket.IO schema、rate limit、房主管理或檢舉機制繞過；
- Android Overlay／前景服務或 Tauri IPC／keyring 邊界問題；
- build、release、公開匯出或供應鏈導致秘密／私人檔案外洩。

純內容爭議、一般濫用、容量不足或缺少產品功能，通常不屬安全漏洞，請依 [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md) 處理。

## 測試規則

善意研究者應：

- 優先使用本機、temporary DB、ephemeral port 與 synthetic pages；
- 只測試自己建立的房間、訊息、裝置及帳戶／識別；
- 避免存取、修改或刪除第三人資料；
- 不做阻斷服務、垃圾訊息、社交工程、實體攻擊或大規模自動掃描；
- 發現真實資料或秘密後立即停止，不下載、不擴散；
- 給予合理修正時間後再協調公開。

本政策不是對任何行為的法律授權或法律意見，也不能約束第三方。研究前仍須遵守適用法律與服務條款。

## 已知信任邊界

- Backend 固定監聽 `127.0.0.1`；正式環境的 TLS/WSS、公開埠與 header 清理由可信 reverse proxy 負責。
- `TRUST_CLOUDFLARE_PROXY=1` 只應在立即 peer 為 loopback 且 proxy 會覆寫不可信 forwarding headers 時使用。
- Origin allowlist 只限制瀏覽器來源並降低濫用，不是使用者認證。原生客戶端可能沒有 Origin；公開 extension ID 也不是秘密。
- 房主管理以高熵 owner credential 為 capability。伺服器只保存對應雜湊；清除本機安全儲存可能永久失去房主權限，沒有帳號復原流程。
- Android owner credential 由 Android Keystore 保護；Desktop 使用 OS credential vault；Extension credential 只應由可信 extension context/background 存取，不得回傳 content script。
- 擴充功能的廣泛 host permission 技術能力很強；實作政策是不讀取或傳送宿主頁面內容。詳見 [docs/extension-permissions.md](docs/extension-permissions.md)。

## 部署者責任

自架者必須自行維護 TLS、reverse proxy、作業系統、Node／Rust／Android 工具鏈、依賴更新、資料庫權限、備份、日誌與事件回應。不要將開發 endpoint、預設範例值或未簽章 artifact 當成正式安全保證。

本專案依 [LICENSE](LICENSE) 按現狀提供；原作者不為第三方修改、部署、內容或安全事件承擔責任，法律不得排除者除外。

# Chrome／Edge 擴充功能權限說明

本文件用白話說明 Manifest V3 擴充功能要求的能力、技術風險與專案自我限制。瀏覽器顯示的警告是正確且重要的；不要因為本文件而忽略警告。

## 權限摘要

| Manifest 項目 | 用途 | 專案允許的行為 |
|---|---|---|
| `content_scripts.matches`: `http://*/*`, `https://*/*` | 安裝後在一般網站自動建立 Overlay | 只建立專案自己的 Shadow DOM host、懸浮球、彈幕舞台與面板 |
| `storage` | 保存設定、clientId、房間狀態與可信 context 的房主憑證 | 非敏感狀態可供 UI 使用；owner credential 不回傳 content script |
| Extension CSP／連線目的地 | 連到建置時指定的 HTTPS/WSS Socket.IO backend | 只連固定 build endpoint；不載入遠端 JavaScript、字型或 executable code |

最終打包內容若出現其他 API 權限，必須在發布前更新本表、提供功能理由與測試。設計上不因方便申請 `tabs`、`scripting`、`webNavigation` 或任意下載權限。

## 為何需要所有一般網站範圍

產品決策是「安裝後跨網站自動顯示」，而不是每一站都要求使用者再次點擊。宣告式 content script 因此匹配一般 HTTP 與 HTTPS 頁面。Chrome／Edge 會產生醒目權限警告，因為 host access 在技術上能讓 extension code 於這些頁面執行，能力非常廣。

**技術上能做，不代表本專案會做。** 本專案的 source 與安全契約禁止：

- 讀取或上傳正文、DOM 內容、表單、輸入框及剪貼簿；
- 讀取宿主頁 cookie、localStorage、sessionStorage 或網址參數；
- 修改宿主頁既有 DOM、CSS、表單或事件處理；
- 把頁面資料傳給 background 或 backend；
- 建立讓頁面任意呼叫 extension API 的 `window.postMessage` bridge；
- 載入 CDN、remote script、remote font、`eval` 或執行期下載的程式碼。

content script 使用隔離執行環境，UI 放在 Shadow DOM。Overlay host 預設不攔截頁面操作，只有懸浮球、面板與對話框接受 pointer events。

## 哪些頁面不能顯示

瀏覽器平台禁止或限制 extension 注入下列頁面：

- `chrome://`、`edge://` 等瀏覽器內部頁；
- Chrome Web Store、Edge Add-ons 等商店頁；
- 其他 extension 頁面、部分內建 PDF／新分頁及瀏覽器保護頁；
- 使用者或企業政策撤銷權限的網站。

工具列入口應把這些情形顯示為「此頁不允許注入」，而不是誤報成 backend 斷線。

## 單一背景連線

所有分頁共用 background service worker 的單一 Socket.IO 連線。content script 只傳送 allowlisted、結構化命令，background 負責：

- clientId、目前房間與 joined rooms；
- Socket 重連與 typed ACK；
- owner credential 隔離；
- 把 sanitized 狀態與訊息同步至頂層頁面。

service worker 可能被瀏覽器終止並重啟，因此非敏感狀態需可恢復，listener 必須 idempotent，不能依賴永久記憶體或用 keepalive spam 規避生命週期。

## Credential 儲存

`chrome.storage.local` 預設可能暴露給 content scripts。支援的瀏覽器版本應呼叫 `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` 限制可信 extension context；即使 API 不支援，也必須維持 background-only message architecture，絕不把 owner credential 回傳 content script、頁面、console 或錯誤文字。

extension storage 不是密碼保險箱，也不保證作業系統層級加密。任何能完全控制瀏覽器 profile／裝置的程式可能取得資料。清除 extension data 會失去無帳號房主權限。

## Backend 與 Origin

- Backend URL 在建置時固定；公開 source 的 development 預設只能指向 loopback，不應偷偷連官方服務。
- 正式 endpoint 必須使用 HTTPS/WSS。
- Backend 可 allowlist `chrome-extension://<extension-id>` Origin；extension ID 是公開識別，不是秘密，也不是使用者認證。
- 房主管理仍以 server-side owner credential、schema validation、rate limit 與 constant-time comparison 為權威。

## 使用者如何控制

你可以在瀏覽器的 extension 詳細資料頁：

- 停用或移除擴充功能；
- 撤銷／限制網站存取；
- 清除 extension 資料；
- 檢查實際 manifest、service worker、content script 與網路請求。

撤銷廣泛網站權限後自動注入會停止；這不代表 backend 故障。重新授權前請先確認版本與發布者。

## 發布前可稽核項目

1. Manifest 只有文件化且實際使用的權限。
2. `content_scripts.matches` 只有一般 HTTP／HTTPS，且 `all_frames` 為 false／只在 top frame 建立 UI。
3. CSP 不含 `unsafe-eval` 或任意 remote code 來源。
4. build output／ZIP 不含 sourcemap、私鑰、`.env`、`node_modules` 或未替換 endpoint placeholder。
5. 實際瀏覽器測試證明跨 tab 只有一條 Socket。
6. 惡意 HTML 字串只顯示為文字；宿主 CSS 不污染 Shadow DOM。
7. Network 只有預期 backend，console 沒有 credential 或未處理錯誤。

## 官方參考

- Chrome：宣告權限與 host permissions：<https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- Chrome：Content scripts 與 isolated world：<https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- Chrome：Extension service worker 生命週期：<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome：Storage API 與 access level：<https://developer.chrome.com/docs/extensions/reference/api/storage>

本文件是技術與政策說明，不是法律意見。商店 privacy disclosure 必須依最終 manifest、build output、實際 endpoint 與商店當時規則重新核對。

function send(action, payload = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ action, payload }, (response) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: { message: '背景服務暫時無法使用' } });
    else resolve(response || { ok: false, error: { message: '背景服務沒有回應' } });
  }));
}

const status = document.getElementById('status');
const details = document.getElementById('details');
const toggle = document.getElementById('toggle-overlay');
const openOptions = document.getElementById('open-options');
const privacyConsent = document.getElementById('privacy-consent');
const appControls = document.getElementById('app-controls');
const consentAccept = document.getElementById('consent-accept');
const consentDecline = document.getElementById('consent-decline');
let activeTabId = null;

function setStatus(kind, title, message) {
  document.body.dataset.state = kind;
  status.textContent = title;
  details.textContent = message;
}

function showConsentRequired() {
  privacyConsent.hidden = false;
  appControls.hidden = true;
  document.body.dataset.state = 'consent';
  status.textContent = '需要隱私同意';
}

async function refresh() {
  const stateResponse = await send('state/get', {});
  if (!stateResponse.ok) {
    privacyConsent.hidden = true;
    appControls.hidden = false;
    setStatus('unavailable', '背景服務暫時無法使用', stateResponse.error?.message || '請稍後再試。');
    toggle.disabled = true;
    return;
  }
  if (stateResponse.state?.privacyConsent !== true) {
    showConsentRequired();
    return;
  }

  privacyConsent.hidden = true;
  appControls.hidden = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;
  if (!activeTabId) { setStatus('unavailable', '找不到目前分頁', '請切換到一般網頁後再試。'); toggle.disabled = true; return; }
  const url = String(tab.url || '');
  if (url && !/^https?:/i.test(url)) { setStatus('protected', '受保護頁面', '瀏覽器內建頁面不允許擴充套件注入。'); toggle.disabled = true; return; }
  if (url) {
    try {
      const origin = `${new URL(url).origin}/*`;
      const granted = await chrome.permissions.contains({ origins: [origin] });
      if (!granted) { setStatus('permission', '網站權限已關閉', '請在瀏覽器的網站存取設定重新允許此擴充套件。'); toggle.disabled = true; return; }
    } catch { /* unavailable URL is handled by registration state */ }
  }
  const response = await send('popup/status', { tabId: activeTabId });
  if (!response.ok || !response.registered) { setStatus('unavailable', '此頁面尚未就緒', '重新整理一般 HTTP/HTTPS 頁面後再試。'); toggle.disabled = true; return; }
  const connected = response.state?.connection?.status === 'connected';
  setStatus(connected ? 'connected' : 'backend', connected ? 'Overlay 已就緒' : '後端連線中斷', connected ? '可控制目前頁面的彈幕面板。' : 'Overlay 仍可設定，訊息會在重新連線後恢復。');
  toggle.disabled = false;
  toggle.textContent = response.state?.overlayEnabled === false ? '顯示 Overlay' : '切換面板';
}

toggle.addEventListener('click', async () => {
  if (!activeTabId) return;
  const response = await send('overlay/toggle', { tabId: activeTabId });
  if (!response.ok) setStatus('unavailable', '無法控制此頁面', response.error?.message || '請重新整理頁面。');
  else window.close();
});
consentAccept.addEventListener('click', async () => {
  const response = await send('privacy/consent', {});
  if (!response.ok) { status.textContent = response.error?.message || '無法儲存同意狀態'; return; }
  await refresh();
});
consentDecline.addEventListener('click', async () => {
  await send('privacy/revoke', {});
  showConsentRequired();
  status.textContent = '尚未同意，不會建立網路連線';
});
openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
refresh();

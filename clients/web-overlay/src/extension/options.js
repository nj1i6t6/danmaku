function send(action, payload = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ action, payload }, (response) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: { message: '背景服務暫時無法使用' } });
    else resolve(response || { ok: false, error: { message: '背景服務沒有回應' } });
  }));
}
const form = document.getElementById('appearance-form');
const result = document.getElementById('result');
const fields = {
  ballSize: document.getElementById('ball-size'),
  danmakuSize: document.getElementById('danmaku-size'),
  panelWidth: document.getElementById('panel-width'),
};
function message(text, error = false) { result.textContent = text; result.dataset.error = String(error); }
async function load() {
  const response = await send('state/get', {});
  if (!response.ok) { message(response.error?.message || '讀取設定失敗', true); return; }
  fields.ballSize.value = response.state.settings.ball.size;
  fields.danmakuSize.value = response.state.settings.danmaku.size;
  fields.panelWidth.value = response.state.settings.panel.width;
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await send('settings/update', { settings: { ball: { size: Number(fields.ballSize.value) }, danmaku: { size: Number(fields.danmakuSize.value) }, panel: { width: Number(fields.panelWidth.value) } } });
  message(response.ok ? '設定已儲存，所有分頁會立即同步。' : response.error?.message || '儲存失敗', !response.ok);
});
document.getElementById('reset').addEventListener('click', async () => {
  const response = await send('settings/reset', {});
  message(response.ok ? '外觀已恢復預設；房間、暱稱與房主管理能力不受影響。' : response.error?.message || '重設失敗', !response.ok);
  if (response.ok) load();
});
load();

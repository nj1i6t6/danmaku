'use strict';

(() => {
  const destinationRules = {
    androidDownload: (url) => url.hostname === 'github.com' && /^\/nj1i6t6\/danmaku\/releases\/download\/v[^/]+\/[^/]+\.apk$/.test(url.pathname),
    windowsDownload: (url) => url.hostname === 'github.com' && /^\/nj1i6t6\/danmaku\/releases\/download\/v[^/]+\/[^/]+\.exe$/.test(url.pathname),
    macosDownload: (url) => url.hostname === 'github.com' && /^\/nj1i6t6\/danmaku\/releases\/download\/v[^/]+\/[^/]+\.dmg$/.test(url.pathname),
    extensionDownload: (url) => url.hostname === 'github.com' && /^\/nj1i6t6\/danmaku\/releases\/download\/v[^/]+\/[^/]+\.zip$/.test(url.pathname),
    repository: (url) => url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname),
    chromeStore: (url) => url.hostname === 'chromewebstore.google.com' && url.pathname.startsWith('/detail/'),
    edgeStore: (url) => url.hostname === 'microsoftedge.microsoft.com' && url.pathname.startsWith('/addons/detail/'),
  };

  const getVerifiedUrl = (value, key) => {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      const allowed = destinationRules[key];
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed?.(url)) return '';
      return url.href;
    } catch {
      return '';
    }
  };

  const hydrateConfiguredLinks = () => {
    const configRoot = document.getElementById('downloads');
    if (!configRoot || typeof document.querySelectorAll !== 'function') return;

    const links = {
      androidDownload: getVerifiedUrl(configRoot.dataset.androidDownload, 'androidDownload'),
      windowsDownload: getVerifiedUrl(configRoot.dataset.windowsDownload, 'windowsDownload'),
      macosDownload: getVerifiedUrl(configRoot.dataset.macosDownload, 'macosDownload'),
      extensionDownload: getVerifiedUrl(configRoot.dataset.extensionDownload, 'extensionDownload'),
      chromeStore: getVerifiedUrl(configRoot.dataset.chromeStore, 'chromeStore'),
      edgeStore: getVerifiedUrl(configRoot.dataset.edgeStore, 'edgeStore'),
      repository: getVerifiedUrl(configRoot.dataset.repository, 'repository'),
    };

    document.querySelectorAll('[data-link-key]').forEach((node) => {
      const destination = links[node.dataset.linkKey];
      const control = node.matches?.('button[data-link-key]') ? node : node.querySelector('button');
      if (!destination || !control) return;

      const anchor = document.createElement('a');
      anchor.className = control.className.replace(/\bis-pending\b/g, '').trim();
      anchor.href = destination;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = control.dataset.linkLabel || control.textContent.trim();
      if (control === node) control.replaceWith(anchor);
      else node.replaceChildren(anchor);
    });
  };

  hydrateConfiguredLinks();
})();

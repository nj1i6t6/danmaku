'use strict';

/**
 * 內容過濾模組
 * 偵測順序：URL → 聯繫方式 → 辱罵 → 重複字元
 *
 * - URL 偵測 → shadow drop
 * - 聯繫方式偵測 → shadow drop
 * - 辱罵/粗俗詞 → reject
 * - 重複字元灌水 → 縮短到 10 個
 */

// 常見短網址域名
const SHORT_URL_DOMAINS = [
  'bit.ly', 'tinyurl', 't.co', 'goo.gl',
  'reurl.cc', 'picsee', 'lihi1',
];

// URL 正規表達式
const URL_PATTERN = /https?:\/\/|www\./i;

// 通訊軟體關鍵詞（正規化+小寫後比對）
const MESSAGING_KEYWORDS = [
  // LINE
  'line', '賴', '加賴', '加懶',
  // Telegram
  'telegram', 'tg', '踢居',
  // WeChat
  'wechat', '微信', '微訊',
  // Instagram
  'ig', 'instagram',
  // Messenger
  'messenger', 'fb', 'fb訊息',
  // WhatsApp
  'whatsapp', 'wa',
  // Discord
  'discord', 'dc', '迪斯可',
  // Signal
  'signal',
];

// 上下文詞
const CONTEXT_WORDS = [
  '加我', '私訊', '私', '加', '群組', '群',
  'id', '聯絡', '聯繫', '找我', '密我',
];

// 管道正規表達式
const PHONE_PATTERN = /09\d{8}/;                    // 手機號碼
const MENTION_PATTERN = /@[a-z0-9_]{3,}/;           // @帳號（至少 3 碼）
const EMAIL_PATTERN = /\w+@\w+\.\w+/;               // email
// 明顯 ID 字串：英數混合 6 碼以上（需搭配通訊軟體關鍵詞）
const ID_PATTERN = /[a-z0-9]{6,}/i;

// 辱罵/粗俗詞表（中文為主，包含常見變體）
const PROFANITY_LIST = [
  '幹', '操', '靠北', '靠腰', '機掰', '雞掰', ' jb',
  '白痴', '白癡', '腦殘', '腦缺', '廢物', '垃圾',
  '三小', '三八', '白目', '智障', '龜兒子', '龜孫',
  '去死', '滾蛋', '吃屎', '放屁', '王八蛋', '混帳',
  '他媽', '她媽', '它媽', '媽的', '他馬的',
  '草泥馬', 'fuck', 'shit', 'damn', 'bitch',
  '狗屎', '豬頭', '神經病', '變態',
];

// 短網址比對正規表達式
const SHORT_URL_PATTERN = new RegExp(
  SHORT_URL_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|'),
  'i'
);

/**
 * 偵測 URL
 * @param {string} text - 正規化後的文字
 * @returns {boolean}
 */
function detectURL(text) {
  if (URL_PATTERN.test(text)) return true;
  if (SHORT_URL_PATTERN.test(text)) return true;
  return false;
}

/**
 * 偵測聯繫方式
 * 命中邏輯 = (通訊軟體關鍵詞 OR 上下文詞) AND (管道)
 * @param {string} text - 正規化後的文字
 * @returns {boolean}
 */
function detectContact(text) {
  // 偵測管道
  const hasPhone = PHONE_PATTERN.test(text);
  const hasMention = MENTION_PATTERN.test(text);
  const hasEmail = EMAIL_PATTERN.test(text);
  const hasURL = detectURL(text);

  // 偵測通訊軟體關鍵詞
  const hasMessagingKeyword = MESSAGING_KEYWORDS.some(kw => text.includes(kw));

  // 偵測上下文詞
  const hasContextWord = CONTEXT_WORDS.some(word => text.includes(word));

  // (通訊軟體關鍵詞 OR 上下文詞) AND (管道)
  if ((hasMessagingKeyword || hasContextWord) && (hasPhone || hasMention || hasEmail || hasURL)) {
    return true;
  }

  // 特別處理：通訊軟體關鍵詞 + 明顯 ID 字串
  if (hasMessagingKeyword) {
    // 去除已知的通訊軟體關鍵詞後，檢查是否還有英數混合 6 碼以上的 ID
    let remaining = text;
    for (const kw of MESSAGING_KEYWORDS) {
      remaining = remaining.split(kw).join(' ');
    }
    // 去除手機號碼
    remaining = remaining.replace(PHONE_PATTERN, ' ');
    // 去除 @ 帳號
    remaining = remaining.replace(MENTION_PATTERN, ' ');
    // 去除 email
    remaining = remaining.replace(EMAIL_PATTERN, ' ');

    // 檢查剩餘文字中是否有英數混合 6 碼以上的字串
    const matches = remaining.match(/[a-z0-9]{6,}/gi);
    if (matches && matches.length > 0) {
      // 確認是英數混合（不是純數字也不是純英文）
      const isMixed = matches.some(m => /[a-z]/i.test(m) && /\d/.test(m));
      if (isMixed) return true;
    }
  }

  return false;
}

/**
 * 偵測辱罵/粗俗詞
 * @param {string} text - 正規化後的文字
 * @returns {boolean}
 */
function detectProfanity(text) {
  return PROFANITY_LIST.some(word => text.includes(word));
}

/**
 * 縮短重複字元（超過 10 次的縮到 10 個）
 * @param {string} text - 正規化後的文字
 * @returns {string} 處理後的文字
 */
function collapseRepeatedChars(text) {
  // 偵測同一字元連續重複超過 10 次
  return text.replace(/(.)\1{9,}/g, (match, char) => {
    return char.repeat(10);
  });
}

/**
 * 檢查內容
 * @param {string} text - 正規化後的文字
 * @returns {{ action: 'pass'|'shadow_drop'|'reject', reason?: string, cleanedText?: string }}
 */
function checkContent(text) {
  // 1. URL 偵測 → shadow drop
  if (detectURL(text)) {
    return { action: 'shadow_drop', reason: '包含連結' };
  }

  // 2. 聯繫方式偵測 → shadow drop
  if (detectContact(text)) {
    return { action: 'shadow_drop', reason: '包含聯繫方式' };
  }

  // 3. 辱罵/粗俗詞 → reject
  if (detectProfanity(text)) {
    return { action: 'reject', reason: '這句可能不雅，請修改' };
  }

  // 4. 重複字元灌水 → 縮短
  const cleanedText = collapseRepeatedChars(text);

  return { action: 'pass', cleanedText };
}

module.exports = {
  checkContent,
  detectURL,
  detectContact,
  detectProfanity,
  collapseRepeatedChars,
};

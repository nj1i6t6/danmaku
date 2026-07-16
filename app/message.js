const { randomUUID } = require('node:crypto');

const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createBarrageMessage({ text, nickname, color, sessionId, timestamp = Date.now(), idFactory = randomUUID }) {
  return {
    messageId: idFactory(),
    text,
    nickname,
    color,
    timestamp,
    sessionId,
  };
}

function resolveReportedMessageId(recentMessages, report) {
  const explicitId = typeof report?.messageId === 'string' ? report.messageId.trim() : '';
  if (MESSAGE_ID_PATTERN.test(explicitId)) return explicitId;

  const messageText = typeof report?.messageText === 'string' ? report.messageText : '';
  const targetSessionId = typeof report?.targetSessionId === 'string' ? report.targetSessionId : '';
  if (!messageText || !Array.isArray(recentMessages)) return null;

  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const message = recentMessages[i];
    if (message?.text !== messageText) continue;
    if (targetSessionId && message?.sessionId !== targetSessionId) continue;
    if (MESSAGE_ID_PATTERN.test(message?.messageId || '')) return message.messageId;
  }
  return null;
}

module.exports = {
  createBarrageMessage,
  resolveReportedMessageId,
};

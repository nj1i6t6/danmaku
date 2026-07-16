'use strict';

/**
 * Reply through Socket.IO acknowledgement when the client supplied one.
 * Legacy clients that do not use acknowledgements keep receiving events.
 */
function respond(socket, callback, fallbackEvent, payload) {
  if (typeof callback === 'function') {
    callback(payload);
    return;
  }
  socket.emit(fallbackEvent, payload);
}

/**
 * A shadow-dropped message must stay invisible to other clients, but an ack-based
 * sender still needs a terminal response so its input does not remain pending.
 */
function acknowledgeShadowDrop(callback) {
  if (typeof callback === 'function') {
    callback({ success: true });
  }
}

module.exports = { respond, acknowledgeShadowDrop };

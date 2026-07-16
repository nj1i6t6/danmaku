'use strict';

const net = require('node:net');

function normalizeAddress(value) {
  if (typeof value !== 'string') return null;
  let address = value.trim();
  if (!address || address.includes(',')) return null;
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return net.isIP(address) ? address : null;
}

function isLoopback(address) {
  return address === '::1' || address.startsWith('127.');
}

function resolveClientIp({ remoteAddress, headers = {}, trustCloudflareProxy = false }) {
  const peer = normalizeAddress(remoteAddress) || 'unknown';
  if (!trustCloudflareProxy || !isLoopback(peer)) return peer;
  return normalizeAddress(headers['cf-connecting-ip']) || peer;
}

module.exports = { normalizeAddress, isLoopback, resolveClientIp };

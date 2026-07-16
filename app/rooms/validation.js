'use strict';

const { fail } = require('./errors');
const { normalize } = require('../protection/normalize');
const { checkContent } = require('../protection/contentFilter');

const ALLOWED_KEYS = new Set(['name', 'visibility', 'password', 'retentionDays']);
const NAME_PATTERN = /^[\p{Script=Han}\p{Script=Latin}\p{N} _-]+$/u;

function normalizeName(value) {
  if (typeof value !== 'string') fail('VALIDATION_ERROR', 'room name must be a string');
  const name = value.normalize('NFKC').replace(/[\p{White_Space}\u200B-\u200D\uFEFF]+/gu, ' ').trim();
  const length = Array.from(name).length;
  if (length < 2 || length > 24 || !NAME_PATTERN.test(name)) {
    fail('VALIDATION_ERROR', 'room name must be 2-24 allowed visible characters');
  }
  const content = checkContent(normalize(name));
  if (content.action !== 'pass') {
    fail('VALIDATION_ERROR', 'room name contains prohibited content');
  }
  return name;
}

function normalizePassword(value, { optional = true } = {}) {
  if ((value === undefined && optional) || value === null || value === '') return null;
  if (typeof value !== 'string') fail('VALIDATION_ERROR', 'password must be a string');
  const length = Array.from(value).length;
  if (length < 6 || length > 64) fail('VALIDATION_ERROR', 'password must be 6-64 characters');
  return value;
}

function normalizeRoomInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION_ERROR', 'invalid room payload');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) fail('VALIDATION_ERROR', `unsupported field: ${key}`);
  }
  const name = normalizeName(input.name);
  const visibility = input.visibility === undefined ? 'public' : input.visibility;
  if (visibility !== 'public' && visibility !== 'unlisted') fail('VALIDATION_ERROR', 'invalid visibility');
  const retentionDays = input.retentionDays === undefined ? 7 : input.retentionDays;
  if (![1, 3, 7].includes(retentionDays)) fail('VALIDATION_ERROR', 'retentionDays must be 1, 3, or 7');
  const password = normalizePassword(input.password);
  if (visibility === 'public' && password !== null) fail('VALIDATION_ERROR', 'public rooms cannot have passwords');
  return { name, visibility, retentionDays, password };
}

function normalizeRoomUpdate(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION_ERROR', 'invalid room payload');
  const allowed = new Set(['name', 'visibility', 'password']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail('VALIDATION_ERROR', `unsupported field: ${key}`);
  }
  if (Object.keys(input).length === 0) fail('VALIDATION_ERROR', 'no changes supplied');
  const next = {
    name: input.name === undefined ? current.name : normalizeName(input.name),
    visibility: input.visibility === undefined ? current.visibility : input.visibility,
    password: input.password === undefined ? current.password : normalizePassword(input.password),
  };
  if (!['public', 'unlisted'].includes(next.visibility)) fail('VALIDATION_ERROR', 'invalid visibility');
  if (next.visibility === 'public' && next.password !== null) fail('VALIDATION_ERROR', 'remove password before making room public');
  return next;
}

module.exports = { normalizeName, normalizePassword, normalizeRoomInput, normalizeRoomUpdate };

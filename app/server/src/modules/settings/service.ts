import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import QRCode from 'qrcode';

import { VersionConflictError } from '../../database/optimistic-lock.js';

type HighRiskAction = 'RESTORE';

interface BusinessError extends Error {
  statusCode: number;
  businessCode: string;
}

const pinSessions = new Map<string, number>();
const highRiskTokens = new Map<string, { action: HighRiskAction; expiresAt: number; reservation?: string }>();
const highRiskChallenges = new Map<string, { action: HighRiskAction; expiresAt: number }>();
const sessionLifetime = 12 * 60 * 60 * 1000;
export const highRiskAuthorizationLifetime = 5 * 60 * 1000;
const highRiskChallengeLifetime = 2 * 60 * 1000;

function businessError(statusCode: number, businessCode: string, message: string): BusinessError {
  return Object.assign(new Error(message), { statusCode, businessCode });
}

const publicSettings = (settings: { pinHash: string | null } & Record<string, unknown>) => {
  const { pinHash: _pinHash, ...rest } = settings;
  return rest;
};

export async function getSettings(database: PrismaClient) {
  const value = await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return publicSettings(value);
}

async function assertVersion(database: PrismaClient, version: number) {
  const current = await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  if (current.version !== version) {
    throw new VersionConflictError({
      entity: 'Settings',
      id: '1',
      expectedVersion: version,
      actualVersion: current.version
    });
  }
  return current;
}

export async function updateSettings(
  database: PrismaClient,
  version: number,
  input: {
    appName?: string;
    subtitle?: string;
    userNickname?: string | null;
    userAvatarPath?: string | null;
    autoBackupEnabled?: boolean;
    autoDeductInventory?: boolean;
    defaultRepeatDays?: number;
    onboardingCompleted?: boolean;
  }
) {
  await assertVersion(database, version);
  if (
    input.defaultRepeatDays != null &&
    (!Number.isInteger(input.defaultRepeatDays) || input.defaultRepeatDays < 0 || input.defaultRepeatDays > 365)
  ) {
    throw Object.assign(new Error('推荐避免重复天数必须是 0 到 365 的整数'), { statusCode: 400 });
  }
  const value = await database.settings.update({
    where: { id: 1 },
    data: {
      appName: input.appName,
      subtitle: input.subtitle,
      userNickname: input.userNickname,
      userAvatarPath: input.userAvatarPath,
      autoBackupEnabled: input.autoBackupEnabled,
      autoDeductInventory: input.autoDeductInventory,
      defaultRepeatDays: input.defaultRepeatDays,
      onboardingCompleted: input.onboardingCompleted,
      version: { increment: 1 }
    }
  });
  return publicSettings(value);
}

const hashPin = (pin: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
};

export async function completeOnboarding(
  database: PrismaClient,
  input: {
    version: number;
    nickname: string;
    dinerName: string;
    subtitle?: string;
    userAvatarPath?: string | null;
    pinEnabled?: boolean;
    pin?: string | null;
    defaultRepeatDays?: number;
    autoBackupEnabled?: boolean;
    autoDeductInventory?: boolean;
  }
) {
  const nickname = input.nickname?.trim();
  const dinerName = input.dinerName?.trim();
  if (!nickname || !dinerName) throw Object.assign(new Error('昵称和默认食用者不能为空'), { statusCode: 400 });
  const pinEnabled = input.pinEnabled ?? Boolean(input.pin);
  if (pinEnabled && !/^\d{4,8}$/.test(input.pin ?? ''))
    throw Object.assign(new Error('PIN 必须是 4 到 8 位数字'), { statusCode: 400 });
  const repeatDays = input.defaultRepeatDays ?? 7;
  if (!Number.isInteger(repeatDays) || repeatDays < 0 || repeatDays > 365) {
    throw Object.assign(new Error('推荐避免重复天数必须是 0 到 365 的整数'), { statusCode: 400 });
  }

  const value = await database.$transaction(async (transaction) => {
    await transaction.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const claimed = await transaction.settings.updateMany({
      where: { id: 1, version: input.version, onboardingCompleted: false },
      data: {
        userNickname: nickname,
        subtitle: input.subtitle?.trim() || '今天也要和喜欢的人，好好吃饭。',
        userAvatarPath: input.userAvatarPath?.trim() || null,
        defaultRepeatDays: repeatDays,
        autoBackupEnabled: input.autoBackupEnabled ?? true,
        autoDeductInventory: input.autoDeductInventory ?? true,
        onboardingCompleted: true,
        pinEnabled,
        pinHash: pinEnabled ? hashPin(input.pin!) : null,
        version: { increment: 1 }
      }
    });
    if (!claimed.count) {
      const current = await transaction.settings.findUniqueOrThrow({ where: { id: 1 } });
      if (current.onboardingCompleted) {
        throw businessError(409, 'ONBOARDING_ALREADY_COMPLETED', '首次启动向导已完成，不能再次提交');
      }
      throw new VersionConflictError({
        entity: 'Settings',
        id: '1',
        expectedVersion: input.version,
        actualVersion: current.version
      });
    }

    const existing = await transaction.diner.findFirst({ where: { name: dinerName } });
    if (!existing) await transaction.diner.create({ data: { name: dinerName, active: true } });
    else if (!existing.active) {
      await transaction.diner.update({ where: { id: existing.id }, data: { active: true, version: { increment: 1 } } });
    }
    return transaction.settings.findUniqueOrThrow({ where: { id: 1 } });
  });

  clearPinSessions();
  return publicSettings(value);
}

export async function setPin(database: PrismaClient, version: number, pin: string | null, enabled: boolean) {
  await assertVersion(database, version);
  if (enabled && !/^\d{4,8}$/.test(pin ?? '')) {
    throw Object.assign(new Error('PIN 必须是 4 到 8 位数字'), { statusCode: 400 });
  }
  const value = await database.settings.update({
    where: { id: 1 },
    data: { pinEnabled: enabled, pinHash: enabled ? hashPin(pin!) : null, version: { increment: 1 } }
  });
  clearPinSessions();
  return publicSettings(value);
}

export async function verifyPin(database: PrismaClient, pin: string) {
  const value = await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  if (!value.pinEnabled) return { valid: true, required: false };
  if (!value.pinHash) return { valid: false, required: true };
  const [salt, expected] = value.pinHash.split(':');
  const actual = scryptSync(pin, salt!, 32);
  const target = Buffer.from(expected!, 'hex');
  return { valid: actual.length === target.length && timingSafeEqual(actual, target), required: true };
}

export async function verifyPinAndCreateSession(database: PrismaClient, pin: string) {
  const result = await verifyPin(database, pin);
  if (!result.valid) return { ...result, token: null };
  const token = randomBytes(32).toString('hex');
  pinSessions.set(token, Date.now() + sessionLifetime);
  return { ...result, token };
}

export function validPinSession(token: string | undefined) {
  if (!token) return false;
  const expires = pinSessions.get(token);
  if (!expires || expires < Date.now()) {
    if (expires) pinSessions.delete(token);
    return false;
  }
  return true;
}

export async function createHighRiskAuthorization(
  database: PrismaClient,
  input: { action: HighRiskAction; pin?: string; confirmation?: string; challenge?: string },
  now = Date.now()
) {
  if (input.action !== 'RESTORE') throw Object.assign(new Error('高风险操作类型无效'), { statusCode: 400 });
  const settings = await database.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  if (settings.pinEnabled) {
    if (!(await verifyPin(database, input.pin ?? '')).valid) {
      throw businessError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', 'PIN 验证失败');
    }
  } else {
    if (!input.challenge) {
      const challenge = randomBytes(24).toString('hex');
      highRiskChallenges.set(challenge, { action: input.action, expiresAt: now + highRiskChallengeLifetime });
      return {
        challenge,
        action: input.action,
        expiresAt: new Date(now + highRiskChallengeLifetime).toISOString(),
        requiresConfirmation: true as const
      };
    }
    const challenge = highRiskChallenges.get(input.challenge);
    highRiskChallenges.delete(input.challenge);
    if (
      !challenge ||
      challenge.action !== input.action ||
      challenge.expiresAt < now ||
      input.confirmation !== 'RESTORE_LOCAL_DATA'
    ) {
      throw businessError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', '高风险操作确认无效或已过期');
    }
  }
  const token = randomBytes(32).toString('hex');
  highRiskTokens.set(token, { action: input.action, expiresAt: now + highRiskAuthorizationLifetime });
  return { token, action: input.action, expiresAt: new Date(now + highRiskAuthorizationLifetime).toISOString() };
}

export function reserveHighRiskAuthorization(
  token: string | undefined,
  action: HighRiskAction,
  now = Date.now()
): string {
  if (!token) throw businessError(401, 'HIGH_RISK_AUTHORIZATION_REQUIRED', '恢复前需要二次授权');
  const authorization = highRiskTokens.get(token);
  if (!authorization || authorization.action !== action || authorization.expiresAt < now || authorization.reservation) {
    if (authorization?.expiresAt != null && authorization.expiresAt < now) highRiskTokens.delete(token);
    throw businessError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', '高风险操作授权无效或已过期');
  }
  const reservation = randomBytes(16).toString('hex');
  authorization.reservation = reservation;
  return reservation;
}

export function consumeReservedHighRiskAuthorization(
  token: string | undefined,
  action: HighRiskAction,
  reservation: string,
  now = Date.now()
): void {
  const authorization = token ? highRiskTokens.get(token) : undefined;
  if (
    !token ||
    !authorization ||
    authorization.action !== action ||
    authorization.expiresAt < now ||
    authorization.reservation !== reservation
  ) {
    if (token && authorization?.expiresAt != null && authorization.expiresAt < now) highRiskTokens.delete(token);
    throw businessError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', '高风险操作授权无效或已过期');
  }
  highRiskTokens.delete(token);
}

export function releaseHighRiskAuthorization(token: string | undefined, reservation: string): void {
  if (!token) return;
  const authorization = highRiskTokens.get(token);
  if (!authorization || authorization.reservation !== reservation) return;
  if (authorization.expiresAt < Date.now()) highRiskTokens.delete(token);
  else delete authorization.reservation;
}

export function consumeHighRiskAuthorization(
  token: string | undefined,
  action: HighRiskAction,
  now = Date.now()
): void {
  const reservation = reserveHighRiskAuthorization(token, action, now);
  consumeReservedHighRiskAuthorization(token, action, reservation, now);
}

export function clearPinSessions() {
  pinSessions.clear();
  highRiskTokens.clear();
  highRiskChallenges.clear();
}

export async function createAccessQr(url: string) {
  if (!/^https?:\/\/[\w.:[\]-]+(?:\/.*)?$/.test(url)) {
    throw Object.assign(new Error('局域网访问地址无效'), { statusCode: 400 });
  }
  return {
    url,
    dataUrl: await QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: '#2f282b', light: '#fff8fa' } })
  };
}

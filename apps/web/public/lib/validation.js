export const DEFAULT_API_BASE = '/v2';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_CODE_PATTERN = /^[\p{L}\p{N}_-]+$/u;

export function normalizeApiBase(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) {
    throw new TypeError('请填写 API 地址');
  }

  if (candidate.startsWith('/')) {
    if (candidate.includes('..') || candidate.includes('\\')) {
      throw new TypeError('API 地址不能包含上级路径');
    }
    return candidate.replace(/\/+$/, '') || '/';
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError('API 地址格式不正确');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('API 地址只能使用 http 或 https');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('API 地址不能包含账号或密码');
  }

  return parsed.toString().replace(/\/+$/, '');
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateLoginInput(email, password) {
  const errors = {};
  if (!EMAIL_PATTERN.test(normalizeEmail(email))) {
    errors.email = '请输入有效的邮箱地址';
  }
  if (String(password ?? '').length < 1) {
    errors.password = '请输入密码';
  } else if (String(password).length > 256) {
    errors.password = '密码不能超过 256 个字符';
  }
  return errors;
}

export function normalizeInvitationCode(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

export function validateInvitationCode(value) {
  const code = normalizeInvitationCode(value);
  if (code.length < 4 || code.length > 32) {
    return '邀请码需为 4～32 个字符';
  }
  if (!INVITATION_CODE_PATTERN.test(code)) {
    return '邀请码只能使用中文、字母、数字、下划线或短横线';
  }
  return '';
}

export function validateInvitationSignupInput({
  code,
  email,
  displayName,
  password,
}) {
  const errors = {};
  const normalizedCode = normalizeInvitationCode(code);
  const codeError = validateInvitationCode(normalizedCode);
  if (codeError) errors.code = codeError;
  if (!EMAIL_PATTERN.test(normalizeEmail(email))) {
    errors.email = '请输入有效的邮箱地址';
  }
  const normalizedName = String(displayName ?? '').trim();
  if (!normalizedName) {
    errors.displayName = '请填写家里怎么称呼你';
  } else if (normalizedName.length > 60) {
    errors.displayName = '称呼不能超过 60 个字符';
  }
  const credential = String(password ?? '');
  if (credential.length < 12) {
    errors.password = '密码至少需要 12 位';
  } else if (credential.length > 256) {
    errors.password = '密码不能超过 256 个字符';
  }
  return {
    errors,
    value: {
      code: normalizedCode,
      email: normalizeEmail(email),
      displayName: normalizedName,
      password: credential,
    },
  };
}

export function validateParticipationInput({
  status,
  participantIds,
  note,
  actualMinutes,
}) {
  const errors = {};
  const normalizedParticipants = Array.isArray(participantIds)
    ? [...new Set(participantIds.map(String).filter(Boolean))]
    : [];
  const normalizedNote = String(note ?? '').trim();
  const normalizedMinutes = String(actualMinutes ?? '').trim();

  if (!['played', 'skipped'].includes(status)) {
    errors.status = '请选择“一起玩了”或“今天先跳过”';
  }
  if (status === 'played' && normalizedParticipants.length === 0) {
    errors.participantIds = '一起玩了时，请至少选择一位陪伴者';
  }
  if (normalizedParticipants.length > 20) {
    errors.participantIds = '陪伴者不能超过 20 位';
  }
  if (normalizedNote.length > 2000) {
    errors.note = '记录不能超过 2000 个字符';
  }
  if (normalizedMinutes) {
    const minutes = Number(normalizedMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      errors.actualMinutes = '实际分钟需为 0～1440 的整数';
    }
  }

  return {
    errors,
    value: {
      status,
      participantIds: normalizedParticipants,
      note: normalizedNote || null,
      actualMinutes: normalizedMinutes ? Number(normalizedMinutes) : null,
    },
  };
}

export function splitTextValues(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitCommaValues(value) {
  return String(value ?? '')
    .split(/[,，、\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validatePreferenceInput({
  availableMaterials,
  excludedMaterials,
  languageMode,
}) {
  const errors = {};
  const available = [...new Set(splitCommaValues(availableMaterials))];
  const excluded = [...new Set(splitCommaValues(excludedMaterials))];
  const excludedSet = new Set(excluded);
  const overlap = available.filter((item) => excludedSet.has(item));
  if (available.length > 200) errors.availableMaterials = '可用材料不能超过 200 项';
  if (excluded.length > 200) errors.excludedMaterials = '排除材料不能超过 200 项';
  if ([...available, ...excluded].some((item) => item.length > 150)) {
    errors.materials = '每项材料名称不能超过 150 个字符';
  }
  if (overlap.length > 0) {
    errors.materials = `“${overlap[0]}”不能同时出现在可用和排除列表`;
  }
  if (!['zh', 'zh_with_english'].includes(languageMode)) {
    errors.languageMode = '请选择中文或中英双语陪伴';
  }
  return {
    errors,
    value: {
      availableMaterials: available,
      excludedMaterials: excluded,
      languageMode,
    },
    valid: Object.keys(errors).length === 0,
  };
}

export function validateChildProfileInput({
  displayName,
  ageMode,
  ageMonths,
  ageAsOf,
  birthDate,
}) {
  const errors = {};
  const normalizedName = String(displayName ?? '').trim();
  if (normalizedName.length > 60) {
    errors.displayName = '孩子称呼不能超过 60 个字符';
  }
  if (!['months', 'birthDate'].includes(ageMode)) {
    errors.ageMode = '请选择月龄或出生日期';
  } else if (ageMode === 'months') {
    const months = Number(ageMonths);
    if (!Number.isInteger(months) || months < 0 || months > 36) {
      errors.ageMonths = '月龄需为 0～36 的整数';
    }
    if (!String(ageAsOf ?? '').trim()) {
      errors.ageAsOf = '请选择月龄对应的日期';
    }
  } else if (!String(birthDate ?? '').trim()) {
    errors.birthDate = '请选择出生日期';
  }
  return {
    errors,
    value: {
      displayName: normalizedName || null,
      ageMode,
      ageMonths: ageMode === 'months' ? Number(ageMonths) : null,
      ageAsOf: ageMode === 'months' ? String(ageAsOf) : null,
      birthDate: ageMode === 'birthDate' ? String(birthDate) : null,
    },
    valid: Object.keys(errors).length === 0,
  };
}

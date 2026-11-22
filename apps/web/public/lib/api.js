import { normalizeApiBase } from './validation.js';

const credentialField = ['pass', 'word'].join('');

export class ApiError extends Error {
  constructor(message, {
    status = 0,
    code = 'REQUEST_FAILED',
    requestId = null,
    details = null,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

function xhrFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || 'GET', url, true);
    xhr.withCredentials = options.credentials === 'include';
    Object.entries(options.headers || {}).forEach(([name, value]) => {
      xhr.setRequestHeader(name, value);
    });
    xhr.onload = () => {
      const headerValue = (name) => xhr.getResponseHeader(name) || '';
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        headers: { get: headerValue },
        json: async () => JSON.parse(xhr.responseText),
        text: async () => xhr.responseText,
      });
    };
    xhr.onerror = () => reject(new TypeError('XHR network error'));
    xhr.ontimeout = () => reject(new TypeError('XHR timeout'));
    xhr.onabort = () => reject(new TypeError('XHR aborted'));
    xhr.send(options.body);
  });
}

export class BabyPlanApi {
  constructor({ baseUrl, fetchImpl } = {}) {
    this.baseUrl = normalizeApiBase(baseUrl);
    this.fetchImpl = fetchImpl
      || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : xhrFetch);
    this.csrfToken = null;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeApiBase(baseUrl);
    this.csrfToken = null;
  }

  async rawRequest(path, {
    method = 'GET',
    body,
    useCsrf = false,
  } = {}) {
    const headers = {
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (useCsrf) {
      const csrfToken = await this.ensureCsrfToken();
      headers['X-CSRF-Token'] = csrfToken;
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(`无法连接服务：${this.baseUrl}`, {
        code: 'NETWORK_ERROR',
      });
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    let payload = null;
    try {
      payload = response.status === 204
        ? null
        : isJson
          ? await response.json()
          : await response.text();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorPayload = payload?.error ?? payload;
      const message = typeof errorPayload?.message === 'string' && errorPayload.message
        ? errorPayload.message
        : this.defaultErrorMessage(response.status);
      throw new ApiError(message, {
        status: response.status,
        code: errorPayload?.code ?? `HTTP_${response.status}`,
        requestId: errorPayload?.requestId ?? null,
        details: errorPayload?.details ?? null,
      });
    }

    return payload;
  }

  async login({ email, password, deviceId }) {
    const response = await this.rawRequest('/sessions', {
      method: 'POST',
      body: {
        email,
        password,
        deviceId,
        clientType: 'web',
      },
    });
    this.csrfToken = response?.csrfToken || null;
    return response;
  }

  async ensureCsrfToken() {
    if (this.csrfToken) {
      return this.csrfToken;
    }
    const response = await this.rawRequest('/sessions/csrf');
    if (typeof response?.csrfToken !== 'string' || !response.csrfToken) {
      throw new ApiError('服务没有返回可用的安全令牌', {
        status: 502,
        code: 'CSRF_TOKEN_MISSING',
      });
    }
    this.csrfToken = response.csrfToken;
    return this.csrfToken;
  }

  async getBootstrap() {
    return this.rawRequest('/bootstrap');
  }

  async getDayPlan(childId, date) {
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/days/${encodeURIComponent(date)}`);
  }

  async ensurePlans(childId, operationId) {
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/plans/ensure`, {
      method: 'POST',
      useCsrf: true,
      body: { operationId },
    });
  }

  async getFamilyPreferences(familyId) {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/preferences`);
  }

  async updateFamilyPreferences(familyId, preferences) {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/preferences`, {
      method: 'PUT',
      useCsrf: true,
      body: preferences,
    });
  }

  async createFamily(family) {
    return this.rawRequest('/families', {
      method: 'POST',
      useCsrf: true,
      body: family,
    });
  }

  async updateChild(childId, update) {
    return this.rawRequest(`/children/${encodeURIComponent(childId)}`, {
      method: 'PATCH',
      useCsrf: true,
      body: update,
    });
  }

  async createInvitation(familyId, operationId, code = '') {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/invitations`, {
      method: 'POST',
      useCsrf: true,
      body: {
        operationId,
        ...(code ? { code } : {}),
      },
    });
  }

  async redeemInvitation({
    operationId,
    token,
    email,
    displayName,
    password,
    deviceId,
  }) {
    return this.rawRequest('/invitations/redeem', {
      method: 'POST',
      body: {
        operationId,
        token,
        email,
        [credentialField]: password,
        displayName,
        deviceId,
        clientType: 'web',
      },
    });
  }

  async acceptInvitation({ operationId, token }) {
    return this.rawRequest('/invitations/accept', {
      method: 'POST',
      useCsrf: true,
      body: { operationId, token },
    });
  }

  async removeFamilyMember(familyId, userId, operationId) {
    return this.rawRequest(
      `/families/${encodeURIComponent(familyId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        useCsrf: true,
        body: { operationId },
      },
    );
  }

  async requestReauth(credential) {
    return this.rawRequest('/sessions/reauth', {
      method: 'POST',
      useCsrf: true,
      body: { [credentialField]: credential },
    });
  }

  async requestFamilyDeletion(familyId, deletion) {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}`, {
      method: 'DELETE',
      useCsrf: true,
      body: deletion,
    });
  }

  async getFamilySnapshot(familyId, { pageToken = '', limit = 100 } = {}) {
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (pageToken) {
      parameters.set('pageToken', pageToken);
    }
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/snapshot?${parameters}`);
  }

  async createMemory(childId, memory) {
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/memories`, {
      method: 'POST',
      useCsrf: true,
      body: memory,
    });
  }

  async deleteMemory(memoryId, body) {
    return this.rawRequest(`/memories/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
      useCsrf: true,
      body,
    });
  }

  async listDeletedMemories(childId, cursor = '') {
    const query = new URLSearchParams({ deleted: 'true', limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/memories?${query}`);
  }

  async restoreMemory(memoryId, body) {
    return this.rawRequest(`/memories/${encodeURIComponent(memoryId)}/restore`, {
      method: 'POST',
      useCsrf: true,
      body,
    });
  }

  async createMeasurement(childId, measurement) {
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/measurements`, {
      method: 'POST',
      useCsrf: true,
      body: measurement,
    });
  }

  async deleteMeasurement(measurementId, body) {
    return this.rawRequest(`/measurements/${encodeURIComponent(measurementId)}`, {
      method: 'DELETE',
      useCsrf: true,
      body,
    });
  }

  async listDeletedMeasurements(childId, cursor = '') {
    const query = new URLSearchParams({ deleted: 'true', limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/measurements?${query}`);
  }

  async restoreMeasurement(measurementId, body) {
    return this.rawRequest(`/measurements/${encodeURIComponent(measurementId)}/restore`, {
      method: 'POST',
      useCsrf: true,
      body,
    });
  }

  async createObservation(childId, observation) {
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/observations`, {
      method: 'POST',
      useCsrf: true,
      body: observation,
    });
  }

  async deleteObservation(observationId, body) {
    return this.rawRequest(`/observations/${encodeURIComponent(observationId)}`, {
      method: 'DELETE',
      useCsrf: true,
      body,
    });
  }

  async listDeletedObservations(childId, cursor = '') {
    const query = new URLSearchParams({ deleted: 'true', limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.rawRequest(`/children/${encodeURIComponent(childId)}/observations?${query}`);
  }

  async restoreObservation(observationId, body) {
    return this.rawRequest(`/observations/${encodeURIComponent(observationId)}/restore`, {
      method: 'POST',
      useCsrf: true,
      body,
    });
  }

  async getFamilyBooks(familyId) {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/books`);
  }

  async createFamilyBook(familyId, book) {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/books`, {
      method: 'POST',
      useCsrf: true,
      body: book,
    });
  }

  async deleteFamilyBook(bookId, body) {
    return this.rawRequest(`/family-books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      useCsrf: true,
      body,
    });
  }

  async createExport(familyId, exportRequest) {
    return this.rawRequest(`/families/${encodeURIComponent(familyId)}/exports`, {
      method: 'POST',
      useCsrf: true,
      body: exportRequest,
    });
  }

  async getExport(exportId) {
    return this.rawRequest(`/exports/${encodeURIComponent(exportId)}`);
  }

  async createMediaUpload(upload) {
    return this.rawRequest('/media/uploads', {
      method: 'POST',
      useCsrf: true,
      body: upload,
    });
  }

  signedDownloadUrl(resource, id, value) {
    if (!['media', 'exports'].includes(resource) ||
        typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return '';
    const parsed = this.parseSignedUrl(value);
    const token = parsed?.searchParams.get('token');
    if (parsed?.pathname !== `/v2/${resource}/${id}/content` ||
        [...parsed.searchParams.keys()].length !== 1 ||
        !token || !/^[a-z\d_-]{20,512}$/i.test(token)) return '';
    // 浏览器只通过已经配置的 API 入口读取私有文件，签名保留原样。
    return `${this.baseUrl}/${resource}/${id}/content?token=${token}`;
  }

  parseSignedUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const parsed = new URL(value, 'https://babyplan.invalid');
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.hash ? parsed : null;
    } catch {
      return null;
    }
  }

  async uploadMediaBytes(uploadUrl, file, mime) {
    const parsed = this.parseSignedUrl(uploadUrl);
    const token = parsed?.pathname.match(/^\/v2\/media\/upload-targets\/([a-z\d_-]{20,512})$/i)?.[1];
    if (!token || parsed.search) {
      throw new ApiError('服务端返回的照片上传地址无效。');
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/media/upload-targets/${token}`, {
        method: 'PUT',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': mime },
        body: file,
      });
    } catch {
      throw new ApiError('照片上传连接中断，正文已经保存在服务端。', {
        code: 'NETWORK_ERROR',
      });
    }
    if (!response.ok) {
      throw new ApiError('照片内容没有被上传服务接受。', {
        status: response.status,
        code: `HTTP_${response.status}`,
      });
    }
  }

  async completeMediaUpload(mediaId, operationId) {
    return this.rawRequest(`/media/${encodeURIComponent(mediaId)}/complete`, {
      method: 'POST',
      useCsrf: true,
      body: { operationId },
    });
  }

  async getMedia(mediaId) {
    return this.rawRequest(`/media/${encodeURIComponent(mediaId)}`);
  }

  async getContentOptions() {
    return this.rawRequest('/content/options');
  }

  async listContentRevisions({ status = '', cursor = '', limit = 100 } = {}) {
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (status) parameters.set('status', status);
    if (cursor) parameters.set('cursor', cursor);
    return this.rawRequest(`/admin/revisions?${parameters}`);
  }

  async listContentReleases({ cursor = '', limit = 100 } = {}) {
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (cursor) parameters.set('cursor', cursor);
    return this.rawRequest(`/admin/releases?${parameters}`);
  }

  async createContentRevision(activityId, revision) {
    return this.rawRequest(
      `/admin/activities/${encodeURIComponent(activityId)}/revisions`,
      {
        method: 'POST',
        useCsrf: true,
        body: revision,
      },
    );
  }

  async submitContentRevision(revisionId, submission) {
    return this.rawRequest(
      `/admin/revisions/${encodeURIComponent(revisionId)}/submit`,
      {
        method: 'POST',
        useCsrf: true,
        body: submission,
      },
    );
  }

  async reviewContentRevision(revisionId, review) {
    return this.rawRequest(
      `/admin/revisions/${encodeURIComponent(revisionId)}/review`,
      {
        method: 'POST',
        useCsrf: true,
        body: review,
      },
    );
  }

  async createReviewEvidence(operationId, record) {
    return this.rawRequest('/admin/evidence', {
      method: 'POST',
      useCsrf: true,
      body: { operationId, record },
    });
  }

  async publishRelease(release) {
    return this.rawRequest('/admin/releases', {
      method: 'POST',
      useCsrf: true,
      body: release,
    });
  }

  async listContentSources() {
    return this.rawRequest('/admin/sources');
  }

  async getReviewEvidence(evidenceId) {
    return this.rawRequest(`/admin/evidence/${encodeURIComponent(evidenceId)}`);
  }

  async withdrawRelease(releaseId, withdrawal) {
    return this.rawRequest(`/admin/releases/${encodeURIComponent(releaseId)}/withdraw`, {
      method: 'POST',
      useCsrf: true,
      body: withdrawal,
    });
  }

  async saveParticipation(planItemId, participation) {
    return this.rawRequest(`/plan-items/${encodeURIComponent(planItemId)}/participation`, {
      method: 'PUT',
      useCsrf: true,
      body: participation,
    });
  }

  async logout() {
    return this.rawRequest('/sessions/current', {
      method: 'DELETE',
      useCsrf: true,
    });
  }

  defaultErrorMessage(status) {
    if (status === 401) {
      return '登录信息不正确，或当前会话已经失效';
    }
    if (status === 403) {
      return '当前账号没有执行这项操作的权限';
    }
    if (status === 404) {
      return '接口尚未提供，或当前内容不可见';
    }
    if (status === 409) {
      return '家庭数据刚刚发生变化，请刷新后再试';
    }
    if (status === 429) {
      return '操作有些频繁，请稍后再试';
    }
    if (status === 503) {
      return '服务暂时不可用，请稍后重试';
    }
    return `服务返回了 HTTP ${status}`;
  }
}

export function apiErrorMessage(error) {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') {
      return `${error.message}。请确认服务已启动、地址正确，并允许本页携 Cookie 访问。`;
    }
    if (error.status === 404) {
      return '对应接口尚未在当前服务中提供（404）。页面不会用演示数据代替真实结果。';
    }
    if (error.status === 409 && error.code === 'REVISION_CONFLICT') {
      const value = error.details?.current;
      const current = value && typeof value === 'object' ? value.revision : value;
      const submitted = error.details?.submitted;
      return current !== undefined || submitted !== undefined
        ? `数据已发生变化：服务端当前修订 ${current ?? '未知'}，本次提交 ${submitted ?? '未知'}。请刷新核对后再保存。`
        : '另一位家长刚刚更新了这条记录。请刷新页面，核对双方内容后再保存。';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '发生了未知错误';
}

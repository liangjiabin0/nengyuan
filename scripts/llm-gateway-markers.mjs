/**
 * 子代理的档位由 OpenCode 插件写进它 prompt 里的 [[ai4es-model]] / [[ai4es-thinking]] 标记，
 * 网关据此决定这一路请求转到哪个上游、开哪一档思考。
 */

export function collectGatewayText(value, into = []) {
  if (value == null) return into;
  if (typeof value === 'string') {
    if (value) into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGatewayText(item, into);
    return into;
  }
  if (typeof value === 'object') {
    collectGatewayText(value.content, into);
    collectGatewayText(value.text, into);
    collectGatewayText(value.parts, into);
    collectGatewayText(value.prompt, into);
    collectGatewayText(value.description, into);
    collectGatewayText(value.command, into);
    collectGatewayText(value.messages, into);
  }
  return into;
}

/**
 * 标记随子代理的 prompt 进来，只认 user 消息里的。父会话的上下文里也会带上子任务参数
 * （assistant 的 tool_calls、tool 回执），认了会把父代理一起拖到子代理那一档。
 */
export function markerTextChunks(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
  if (!messages) return collectGatewayText(parsed);
  return collectGatewayText(messages.filter((item) => item?.role === 'user'));
}

export function roleFromModelMarker(text) {
  const match = String(text || '').match(/\[\[ai4es-model:(arc|thunder|storm)\]\]/i);
  if (!match) return null;
  const id = match[1].toLowerCase();
  if (id === 'thunder') return 'large';
  if (id === 'storm') return 'storm';
  return 'small';
}

export function thinkingFromMarker(text) {
  const match = String(text || '').match(/\[\[ai4es-thinking:(off|none|low|medium|high|xhigh)\]\]/i);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return id === 'none' ? 'off' : id;
}

export function roleFromBodyMarker(bodyText) {
  for (const chunk of markerTextChunks(bodyText)) {
    const role = roleFromModelMarker(chunk);
    if (role) return role;
  }
  return null;
}

export function thinkingFromBodyMarker(bodyText) {
  for (const chunk of markerTextChunks(bodyText)) {
    const thinking = thinkingFromMarker(chunk);
    if (thinking) return thinking;
  }
  return null;
}

export function stripModelMarker(text) {
  return String(text || '')
    .replace(/\s*\[\[ai4es-model:(?:arc|thunder|storm)\]\]\s*/gi, ' ')
    .replace(/\s*\[\[ai4es-thinking:(?:off|none|low|medium|high|xhigh)\]\]\s*/gi, ' ')
    .trim();
}

export function stripMarkersInParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.content === 'string') value.content = stripModelMarker(value.content);
    if (typeof value.text === 'string') value.text = stripModelMarker(value.text);
    visit(value.content);
    visit(value.parts);
    visit(value.messages);
  };
  visit(parsed);
}

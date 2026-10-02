// 【重建】原文件已丢失，按 dist/runtime/api-app.mjs 还原并补回类型。
// 智能对话里 Agent 向用户提问（question 工具）的读取 / 回答 / 拒绝。
import { NextResponse } from 'next/server';
import { assertConversationOwner } from '@/lib/chat-history';
import { requireUser } from '@/lib/auth/request';
import { ensureChatWorkspace } from '@/lib/chat-generated-charts';
import { canSubmitChatAskAnswers, parseChatAskRequest } from '@/lib/opencode/chat-ask';
import {
  listOpenCodeConversationQuestions,
  rejectOpenCodeConversationQuestion,
  replyOpenCodeConversationQuestion
} from '@/lib/opencode/runtime';

type RouteContext = { params: Promise<{ id: string }> };

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function ownedChatWorkspace(
  request: Request,
  id: string
): Promise<{ error: NextResponse; workingDirectory?: undefined } | { error?: undefined; workingDirectory: string }> {
  const auth = await requireUser(request);
  if (auth.error) return { error: auth.error };
  const ownership = await assertConversationOwner(id, auth.user!.id, 'chat');
  if (!ownership.conversation) return { error: jsonError('会话不存在。', 404) };
  if (!ownership.allowed) return { error: jsonError('无权访问该会话。', 403) };
  return { workingDirectory: ensureChatWorkspace(id) };
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const owned = await ownedChatWorkspace(request, id);
  if (owned.error) return owned.error;
  const questions = await listOpenCodeConversationQuestions(id, {
    workingDirectory: owned.workingDirectory
  });
  return NextResponse.json({ questions });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const owned = await ownedChatWorkspace(request, id);
  if (owned.error) return owned.error;
  const body = await request.json().catch(() => null);
  const requestID = String(body?.requestID || '').trim();
  if (!requestID) return jsonError('缺少提问编号。');
  const action = body?.action === 'reject' ? 'reject' : 'reply';
  try {
    if (action === 'reject') {
      await rejectOpenCodeConversationQuestion(id, requestID, {
        workingDirectory: owned.workingDirectory
      });
      return NextResponse.json({ ok: true, requestID, action });
    }
    const parsed = parseChatAskRequest({
      requestID,
      questions: body?.questions,
      answers: body?.answers,
      pending: false
    });
    // 每个问题的答复统一成字符串数组（多选题可有多个）
    const answers: string[][] = Array.isArray(body?.answers)
      ? (body.answers as unknown[]).map((item) =>
          Array.isArray(item)
            ? item.map((entry) => String(entry || '').trim()).filter(Boolean)
            : String(item || '').trim()
              ? [String(item).trim()]
              : []
        )
      : [];
    if (parsed?.questions.length && !canSubmitChatAskAnswers(parsed.questions, answers)) {
      return jsonError('请为每个问题给出有效选项。');
    }
    if (!answers.length || answers.some((item) => !item.length)) {
      return jsonError('请选择或填写答复后再继续。');
    }
    await replyOpenCodeConversationQuestion(id, requestID, answers, {
      workingDirectory: owned.workingDirectory
    });
    return NextResponse.json({ ok: true, requestID, action });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '提交询问答复失败。', 502);
  }
}

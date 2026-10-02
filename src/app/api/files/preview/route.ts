import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { get } from '@/lib/db';
import { isPathUnderAllowedRoots } from '@/lib/bundle-store';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth/request';
import { originalMentorBaseName, resolveMentorFilePath } from '@/lib/mentors';

function isPathAllowed(filePath: string) {
  return isPathUnderAllowedRoots(filePath, config.dataRootDir);
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 导师文件预览时显示原始长文件名。 */
function previewFileName(sourceType: string, filePath: string) {
  return sourceType === 'mentor'
    ? `${originalMentorBaseName(filePath)}${path.extname(filePath) || '.md'}`
    : path.basename(filePath);
}

function resolvePaper(paperKey: string) {
  return get<{ paper_key: string; title: string; file_path: string; pdf_path: string; abstract?: string }>(
    'SELECT paper_key, title, file_path, pdf_path, abstract FROM paper_documents WHERE paper_key = ?',
    [paperKey]
  );
}

function resolveMentor(mentorKey: string) {
  return get<{ mentor_key: string; name: string; file_path: string; content: string }>(
    'SELECT mentor_key, name, file_path, content FROM mentor_profiles WHERE mentor_key = ?',
    [mentorKey]
  );
}

function resolveProject(projectKey: string) {
  return get<{ project_key: string; project_name: string; summary?: string; institution?: string; principal_investigator?: string; year?: string }>(
    'SELECT project_key, project_name, summary, institution, principal_investigator, year FROM projects WHERE project_key = ?',
    [projectKey]
  );
}

function resolveChunk(chunkKey: string) {
  return get<{ chunk_key: string; paper_key: string }>(
    'SELECT chunk_key, paper_key FROM paper_chunks WHERE chunk_key = ?',
    [chunkKey]
  );
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { searchParams } = new URL(request.url);
    const sourceType = String(searchParams.get('sourceType') || '').trim();
    const sourceKey = String(searchParams.get('sourceKey') || '').trim();
    const mode = String(searchParams.get('mode') || 'auto').trim();

    if (!sourceType || !sourceKey) return jsonError('缺少 sourceType 或 sourceKey。', 400);

    let filePath = '';
    let title = '';
    let textFallback = '';

    if (sourceType === 'paper') {
      const paper = await resolvePaper(sourceKey);
      if (!paper) return jsonError('未找到论文记录。', 404);
      filePath = paper.pdf_path || paper.file_path;
      title = paper.title;
      textFallback = paper.abstract || '';
    } else if (sourceType === 'paper_chunk') {
      const chunk = await resolveChunk(sourceKey);
      const paper = chunk ? await resolvePaper(chunk.paper_key) : null;
      if (!paper) return jsonError('未找到论文分块对应文件。', 404);
      filePath = paper.pdf_path || paper.file_path;
      title = paper.title;
      textFallback = paper.abstract || '';
    } else if (sourceType === 'mentor') {
      const mentor = await resolveMentor(sourceKey);
      if (!mentor) return jsonError('未找到导师记录。', 404);
      // 【按线上版本还原】导师文件可能被改成短文件名，需映射回实际路径。
      filePath = resolveMentorFilePath(mentor.file_path || '');
      title = mentor.name;
      textFallback = mentor.content;
    } else if (sourceType === 'project') {
      const project = await resolveProject(sourceKey);
      if (!project) return jsonError('未找到项目记录。', 404);
      title = project.project_name;
      textFallback = [
        `项目: ${project.project_name}`,
        project.institution ? `机构: ${project.institution}` : '',
        project.principal_investigator ? `负责人: ${project.principal_investigator}` : '',
        project.year ? `年份: ${project.year}` : '',
        project.summary ? `摘要: ${project.summary}` : ''
      ].filter(Boolean).join('\n');
    } else {
      return jsonError(`不支持的 sourceType: ${sourceType}`, 400);
    }

    if (filePath && fs.existsSync(filePath) && isPathAllowed(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.pdf' && mode !== 'text') {
        const bytes = fs.readFileSync(filePath);
        return new NextResponse(bytes, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(filePath))}"`,
            'Cache-Control': 'private, max-age=120'
          }
        });
      }

      if (ext === '.md' || ext === '.markdown' || mode === 'text') {
        const content = fs.readFileSync(filePath, 'utf8');
        return NextResponse.json({
          kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
          title,
          fileName: previewFileName(sourceType, filePath),
          filePath,
          content
        });
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return NextResponse.json({
        kind: 'text',
        title,
        fileName: previewFileName(sourceType, filePath),
        filePath,
        content: content.slice(0, 200_000)
      });
    }

    if (textFallback) {
      const kind = /(^|\n)#{1,6}\s/.test(textFallback) ? 'markdown' : 'text';
      return NextResponse.json({
        kind,
        title,
        fileName: title,
        filePath: filePath || '',
        content: textFallback.slice(0, 200_000)
      });
    }

    return jsonError('文件不存在或路径未授权。', 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : '预览失败';
    return jsonError(message, 500);
  }
}

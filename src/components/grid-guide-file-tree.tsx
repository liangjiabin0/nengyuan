'use client';

import {
  ChevronDown,
  ChevronRight,
  File,
  FileJson,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { GridGuideFileNode } from '@/lib/grid-guide/types';

function fileIcon(node: GridGuideFileNode) {
  const ext = node.extension || '';
  if (ext === '.json' || ext === '.jsonl') return FileJson;
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return FileSpreadsheet;
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return ImageIcon;
  if (ext === '.md' || ext === '.txt' || ext === '.docx' || ext === '.pdf') return FileText;
  return File;
}

function defaultExpanded(nodes: GridGuideFileNode[], prefix = ''): Set<string> {
  const open = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'dir') continue;
    const name = node.name;
    const shouldOpen =
      !prefix
      || name.startsWith('00_')
      || name.startsWith('05_')
      || /^0\d_课题/.test(name)
      || name === '05_正式成果'
      || name === '00_项目总体';
    if (shouldOpen) {
      open.add(node.path);
      if (node.children?.length) {
        for (const child of defaultExpanded(node.children, node.path)) open.add(child);
      }
    }
  }
  return open;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect
}: {
  node: GridGuideFileNode;
  depth: number;
  selectedPath: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: GridGuideFileNode) => void;
}) {
  const isOpen = expanded.has(node.path);
  const selected = selectedPath === node.path;
  const Icon = node.type === 'dir' ? (isOpen ? FolderOpen : Folder) : fileIcon(node);
  const Chevron = node.type === 'dir' ? (isOpen ? ChevronDown : ChevronRight) : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (node.type === 'dir') onToggle(node.path);
          else onSelect(node);
        }}
        title={node.path}
        className={`group flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[12px] leading-4 transition ${
          selected
            ? 'bg-primary/10 text-primary'
            : 'text-foreground/90 hover:bg-accent hover:text-foreground'
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
          {Chevron ? <Chevron className="h-3 w-3" /> : <span className="h-3 w-3" />}
        </span>
        <Icon className={`h-3.5 w-3.5 shrink-0 ${node.type === 'dir' ? 'text-amber-600' : 'text-muted-foreground'}`} />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {node.type === 'dir' && isOpen && node.children?.length ? (
        <div className="relative">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function firstGridGuideFilePath(nodes: GridGuideFileNode[]): string {
  const findByName = (list: GridGuideFileNode[], name: string): string => {
    for (const node of list) {
      if (node.type === 'file' && node.name === name) return node.path;
      if (node.children?.length) {
        const found = findByName(node.children, name);
        if (found) return found;
      }
    }
    return '';
  };
  const prefer = (list: GridGuideFileNode[]): string => {
    for (const node of list) {
      if (node.type === 'file' && (node.path.includes('05_正式成果') || node.name === 'INDEX.md' || node.name === 'TASK.md')) {
        return node.path;
      }
      if (node.children?.length) {
        const found = prefer(node.children);
        if (found) return found;
      }
    }
    return '';
  };
  const walk = (list: GridGuideFileNode[]): string => {
    for (const node of list) {
      if (node.type === 'file') return node.path;
      if (node.children?.length) {
        const found = walk(node.children);
        if (found) return found;
      }
    }
    return '';
  };
  return findByName(nodes, '指南建议稿.docx') || prefer(nodes) || walk(nodes);
}

export function GridGuideFileTree({
  tree,
  selectedPath,
  onSelect,
  emptyHint
}: {
  tree: GridGuideFileNode[];
  selectedPath: string;
  onSelect: (node: GridGuideFileNode) => void;
  emptyHint?: string;
}) {
  const initial = useMemo(() => defaultExpanded(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(initial);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const path of initial) next.add(path);
      return next;
    });
  }, [initial]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-[57px] shrink-0 items-center gap-2 border-b border-border px-4">
        <FolderOpen className="h-4 w-4 text-primary" />
        <div>
          <div className="text-sm font-semibold text-foreground">成果文件</div>
          <div className="text-[10px] text-muted-foreground">点击文件在预览区打开</div>
        </div>
      </header>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {tree.length ? (
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))
        ) : (
          <div className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
            {emptyHint || '生成开始后，任务文件夹会显示在这里。'}
          </div>
        )}
      </div>
    </div>
  );
}

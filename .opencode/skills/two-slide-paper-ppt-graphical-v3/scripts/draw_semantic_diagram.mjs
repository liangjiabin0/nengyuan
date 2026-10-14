/** Native scientific diagram helper for @oai/artifact-tool.
 * Call only after validate_semantic_graph.py --layout passes.
 * No implicit layout, file access, template import, or scientific content synthesis.
 */
export function drawSemanticDiagram(slide, graph, layout) {
  const map = { nodes: {}, edges: {} };
  const font = layout.fontFamily || 'Microsoft YaHei';
  const ink = '#07368C', teal = '#087F8C', orange = '#C26923';
  let names, prefix, serial;
  function begin(category, id) {
    names = []; map[category][id] = names;
    prefix = `dg-${category === 'nodes' ? 'node' : 'edge'}-${id}-`; serial = 0;
  }
  function shape(role, geometry, x, y, w, h, fill = 'none', stroke = ink, lw = 1.5, dash = false) {
    const name = `${prefix}${role}-${++serial}`;
    const object = slide.shapes.add({ name, geometry,
      position: { left: x, top: y, width: Math.max(w, .01), height: Math.max(h, .01) },
      fill, line: { fill: stroke, width: lw, style: dash ? 'dashed' : 'solid' } });
    names.push(name); return object;
  }
  function text(value, x, y, w, h, size, color = ink, bold = false, fill = 'none', stroke = 'none', geometry = 'textbox') {
    const object = shape('label', geometry, x, y, w, h, fill, stroke, stroke === 'none' ? 0 : 1.5);
    object.text = value;
    object.text.style = { typeface: font, fontSize: size, color, bold, alignment: 'center',
      verticalAlignment: 'middle', wrap: 'square', autoFit: 'none',
      insets: { left: 3, right: 3, top: 2, bottom: 2 } };
    return object;
  }
  function segment(x1, y1, x2, y2, color = ink, width = 2, dash = false) {
    if (x1 !== x2 && y1 !== y2) throw Error('Only explicit orthogonal segments are supported');
    return shape('segment', 'line', Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1), 'none', color, width, dash);
  }
  // Edges precede nodes so the node backgrounds keep incoming routes visually clean.
  for (const edge of graph.edges) {
    begin('edges', edge.id);
    const item = layout.edges[edge.id], pts = item.points;
    const color = item.color || (edge.kind === 'power' ? teal : ['control','feedback'].includes(edge.kind) ? orange : ink);
    const dash = item.dashed ?? ['feedback','information','price','response'].includes(edge.kind);
    for (let i=1; i<pts.length; i++) segment(...pts[i-1], ...pts[i], color, edge.kind === 'power' ? 2.8 : 2, dash);
    const a=pts.at(-2), b=pts.at(-1), dx=b[0]-a[0], dy=b[1]-a[1];
    const dir=dx>0?'right':dx<0?'left':dy>0?'down':'up';
    const size=9;
    shape('arrow',dir+'Arrow', b[0]-(dir==='right'?size:dir==='left'?0:size/2), b[1]-(dir==='down'?size:dir==='up'?0:size/2),size,size,color,'none',0);
    const lb=item.labelBox;
    text(edge.label,lb.x,lb.y,lb.w,lb.h,item.fontSize || layout.fontSize,color,false,'#FFFFFF');
  }
  for (const node of graph.nodes) {
    begin('nodes', node.id);
    const n=layout.nodes[node.id], {x,y,w,h}=n, fs=n.fontSize || layout.fontSize;
    const color=n.color || (['battery','solar','load','converter','bus'].includes(n.glyph)?teal:ink);
    if (n.customRenderer) throw Error(`${node.id}: customRenderer requires a task-specific drawing implementation`);
    if (['process','optimizer','controller','data','decision','sum'].includes(n.glyph)) {
      const geom=n.glyph==='decision'?'diamond':n.glyph==='sum'?'ellipse':'roundRect';
      text(node.label,x,y,w,h,fs,color,true,n.fill || '#EAF3FA',color,geom);
      if (n.glyph==='optimizer') {
        segment(x+8,y+7,x+8,y+h-7,color,3);
        segment(x+w-8,y+7,x+w-8,y+h-7,color,3);
      }
      if (n.glyph==='controller') segment(x+10,y+h-7,x+w-10,y+h-7,color,2);
      if (n.glyph==='data') {
        segment(x+6,y+7,x+w-6,y+7,color,1);
        segment(x+6,y+h-7,x+w-6,y+h-7,color,1);
      }
      continue;
    }
    // Device boundary is a semantic node extent. Ports terminate on this light outline.
    shape('boundary','rect',x,y,w,h,'#FFFFFF','#CADBE3',.8);
    const labelH=Math.min(h*.34,fs*2.35), gh=h-labelH-10;
    const gw=Math.min(w*.5,gh*1.2), gx=x+(w-gw)/2, gy=y+5;
    if (n.glyph==='battery') {
      shape('body','rect',gx,gy+5,gw,gh-5,'#E4F1EA',color,2);
      shape('terminal','rect',gx+gw*.35,gy,gw*.3,5,color,'none',0);
      for(let i=0;i<3;i++)shape('cell','rect',gx+6,gy+11+i*(gh-15)/3,gw-12,(gh-20)/4,'#8AC4A8','none',0);
    } else if(n.glyph==='converter') {
      shape('body','rect',gx,gy,gw,gh,'#FFFFFF',color,2);
      segment(gx,gy+gh/2,gx+gw,gy+gh/2,color,1.5);
      text('=',gx,gy,gw,gh/2,fs,color,true);
      text('∼',gx,gy+gh/2,gw,gh/2,fs,color,true);
    } else if(n.glyph==='solar') {
      shape('panel','rect',gx,gy,gw,gh-8,'#D8EDF9',color,2);
      for(let i=1;i<4;i++) segment(gx+gw*i/4,gy,gx+gw*i/4,gy+gh-8,color,1);
      segment(gx,gy+(gh-8)/2,gx+gw,gy+(gh-8)/2,color,1);
      segment(gx+gw/2,gy+gh-8,gx+gw/2,gy+gh,color,2);
    } else if(n.glyph==='load') {
      shape('body','rect',gx,gy,gw,gh,'#FFF1D9',color,2);
      for(let row=0;row<2;row++)for(let col=0;col<3;col++)shape('window','rect',gx+gw*(.12+col*.28),gy+gh*(.12+row*.35),gw*.14,gh*.20,color,'none',0);
    } else if(n.glyph==='user') {
      const d=Math.min(gh*.30,gw*.4);
      for(const offset of [0,.55]){
        shape('head','ellipse',gx+gw*offset,gy,d,d,color,'none',0);
        shape('body','roundRect',gx+gw*offset-d*.1,gy+d+3,d*1.2,gh-d-3,color,'none',0);
      }
    } else if(n.glyph==='bus') {
      segment(x+7,gy+gh/2,x+w-7,gy+gh/2,color,4);
      for(const v of [.2,.5,.8])segment(x+w*v,gy+gh/2,x+w*v,gy+gh,color,2);
    } else throw Error(`Unsupported glyph: ${n.glyph}`);
    text(node.label,x+2,y+h-labelH-2,w-4,labelH,fs,color,true);
  }
  return map;
}

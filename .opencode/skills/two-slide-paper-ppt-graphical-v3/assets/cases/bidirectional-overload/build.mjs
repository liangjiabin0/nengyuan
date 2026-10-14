import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),B=path.join(ROOT,'build'),SK=path.resolve(ROOT,'../../..');
const runtime=process.env.CODEX_RUNTIME_ROOT;
if(!runtime)throw new Error('Set CODEX_RUNTIME_ROOT from load_workspace_dependencies');
const require=createRequire(runtime+'/node/node_modules/entry.cjs');
const {Presentation,PresentationFile}=require('@oai/artifact-tool');
const {drawSemanticDiagram}=await import(pathToFileURL(SK+'/scripts/draw_semantic_diagram.mjs'));
const {renderLatexSvg}=await import(pathToFileURL(SK+'/scripts/render_latex_svg.mjs'));
const ps=process.env.PRESENTATIONS_SKILL_ROOT;
if(!ps)throw new Error('Set PRESENTATIONS_SKILL_ROOT to the installed Presentations skill');
const {applyPresentationChartFont}=await import(pathToFileURL(ps+'/container_tools/artifact_tool_utils.mjs'));
const retained=JSON.parse(await fs.readFile(path.join(ROOT,'reference-data/formula-manifest.json'),'utf8')).formulas;
const spec=JSON.parse(await fs.readFile(B+'/spec.json','utf8')),graph=JSON.parse(await fs.readFile(B+'/semantic-graph.json','utf8')),layout=JSON.parse(await fs.readFile(B+'/diagram-layout.json','utf8'));
const W=1672,H=941,F='Microsoft YaHei',C={navy:'#07368C',ink:'#101D30',blue:'#1673CE',line:'#66B7FA',pale:'#EAF5FF',teal:'#087F8C',gray:'#536477'};
const P=Presentation.create({slideSize:{width:W,height:H}});let seq=0;
function sh(s,g,x,y,w,h,fill='none',stroke='none',lw=0,name){return s.shapes.add({name:name||'native-'+(++seq),geometry:g,position:{left:x,top:y,width:w,height:h},fill,line:{style:'solid',fill:stroke,width:lw}})}
function txt(s,t,x,y,w,h,size=24,c=C.ink,bold=false,align='left',fill='none'){
 const q=sh(s,fill==='none'?'textbox':'roundRect',x,y,w,h,fill);q.text=t;q.text.style={typeface:F,fontSize:size,color:c,bold,alignment:align,verticalAlignment:'middle',wrap:'square',autoFit:'none',insets:{left:6,right:6,top:3,bottom:3}};return q;
}
function panel(s,t,x,y,w,h){sh(s,'roundRect',x,y,w,h,'#FFFFFF',C.line,1);txt(s,t,x+12,y+4,w-24,40,28,C.navy,true)}
function header(s,num,summary,footer){s.background.fill='#FFFFFF';txt(s,spec['slide'+num].title,20,0,1632,64,44,C.navy,true);txt(s,summary,20,92,1632,110,26);txt(s,footer,23,886,1624,44,23,C.navy,true,'center')}
const s1=P.slides.add();
header(s1,1,'以载流设备累积寿命损失量化风险，按问题持续性选择治理路径：\n短时采用 EV–退役储能协同，长期采用光伏汇集与网络扩容。','按短时或长期问题分别治理，并回到同一评估体系；寿命损失、调控目标和规划成本各有明确含义');
panel(s1,'共同基础：双向潮流与风险量化',18,230,432,612);
// Branch lanes leave a shared routing gutter between the assessment and treatment bodies.
panel(s1,'短时治理：有序充电与退役储能协同',625,230,1029,307);
panel(s1,'长期治理：反向汇集与正向扩容协同',625,550,1029,292);
const coverage=drawSemanticDiagram(s1,graph,layout);
txt(s1,'寿命参考值24 h；重载 / 轻载均纳入',26,813,410,25,19,C.gray,false,'center');
txt(s1,'E：年投资成本−年收益；计及容量衰减\nΔFeq：偏离24 h；SOC、电压及载流约束',1152,491,489,45,18,C.gray,false,'center');
txt(s1,'电费激励与等待时间共同影响响应',647,504,468,27,20,C.gray,false,'center');
txt(s1,'功率平衡 / 电压 / 标准容量约束',1114,805,509,27,20,C.gray,false,'center');
txt(s1,'CPLEX交替求解：成本变化≤1% 或50次',1114,776,509,30,20,C.gray,false,'center');
txt(s1,'年规划成本＝年汇集成本＋年扩容成本',650,814,447,24,18,C.gray,false,'center');
txt(s1,'AHP权重汇总为综合得分',73,745,350,23,19,C.gray,false,'center');
const manifest=[];await fs.mkdir(B+'/formula-svg',{recursive:true});
for(const f of spec.slide1.formulas){
 const cached=retained.find(x=>x.id===f.id&&x.latex===f.latex&&x.color===C.navy);
 const svg=cached?await fs.readFile(path.join(ROOT,'reference-data/formula-svg',f.id+'.svg'),'utf8'):await renderLatexSvg({latex:f.latex,color:C.navy,cacheDir:B+'/mathjax-cache'});
 await fs.writeFile(B+'/formula-svg/'+f.id+'.svg',svg,'utf8');
 const b=layout.formulas[f.id],v=svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number),k=Math.min(b.w/v[2],b.h/v[3]);
 const pos={left:b.x+(b.w-v[2]*k)/2,top:b.y+(b.h-v[3]*k)/2,width:v[2]*k,height:v[3]*k};
 const bytes=Buffer.from(svg);s1.images.add({name:'formula-'+f.id,blob:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),contentType:'image/svg+xml',alt:f.latex,fit:'contain',position:pos});
 manifest.push({...f,slide:1,targetShapeName:'formula-'+f.id,position:pos,color:C.navy});
}
s1.speakerNotes.textFrame.setText('Source: '+spec.meta.sourcePath+'\nMethod: PDF pp.22–23 (printed pp.9–10), Fig.2-1 p.24; Eqs.2-2–2-20 pp.28–32; Logit Eqs.3-13,3-14 p.41; Eqs.3-23,3-34 pp.43,46; AIW-PSO pp.48–50; collection/expansion pp.60–70. Each edge provenance in semantic-graph.json. The drawing is a conceptual assessment–treatment–reassessment framework, not a single numerical algorithm. Short and long pathways are alternatives. The source describes a grey prediction route, but the reported long-term case directly scales resources and load (PDF p.71). No independent experiment reproduction is claimed.');
const s2=P.slides.add();
header(s2,2,'三项工作分别验证：季节风险可区分，有序充电降低储能配置需求，汇集–扩容缓解长期重过载。\n各章采用对应场景与评价口径，综合得分表示整体影响，不是风险概率。','仿真基于改进IEEE 33节点系统；长期规划成本独立报告，不能与储能年净成本直接计算节省比例');
panel(s2,'① 评估：区分典型日风险',18,230,492,642);
panel(s2,'② 短时：荷储协同与储能经济性',522,230,568,642);
panel(s2,'③ 长期：汇集–扩容联合规划',1102,230,552,642);
function nativeChart(s,v,x,y,w,h,format='0.00',font=18){
 const colors=['#A1B4CA',C.navy];
 const multiple=v.series.length>1;
 const series=v.series.map((q,i)=>({name:q.name,values:q.values,fill:multiple?colors[i]:C.blue,
    ...(!multiple?{points:v.categories.map((_,j)=>({idx:j,fill:j===1?C.navy:'#A1B4CA',line:{fill:j===1?C.navy:'#A1B4CA',width:1,style:'solid'}}))}:{}),valuesFormatCode:format}));
 const ch=s.charts.add('bar',{name:v.id,position:{left:x,top:y,width:w,height:h},categories:v.categories,series,
  hasLegend:multiple,legend:{position:'top',overlay:false,textStyle:{typeface:F,fontSize:18,fill:C.ink}},
  barOptions:{direction:'column',grouping:'clustered',gapWidth:multiple?85:130},
  dataLabels:{showValue:true,showCategoryName:false,showSeriesName:false,position:'outEnd',numberFormatCode:format,textStyle:{typeface:F,fontSize:font,fill:C.ink}},
  xAxis:{visible:true,position:'bottom',title:{text:v.xTitle,textStyle:{typeface:F,fontSize:17,fill:C.ink}},textStyle:{typeface:F,fontSize:font,fill:C.ink},line:{fill:'#595959',width:1.3,style:'solid'},majorGridlines:{fill:'#A6A6A6',width:1,style:'dashed'}},
  yAxis:{visible:true,position:'left',min:v.yMin,max:v.yMax,majorUnit:v.yMajorUnit,numberFormatCode:'0.##',title:{text:v.yTitle,textStyle:{typeface:F,fontSize:17,fill:C.ink}},textStyle:{typeface:F,fontSize:font,fill:C.ink},line:{fill:'#595959',width:1.3,style:'solid'},majorGridlines:{fill:'#A6A6A6',width:1,style:'dashed'}},chartFill:'#FFFFFF',plotAreaFill:'#FFFFFF',plotAreaLine:{fill:'#595959',width:1.3,style:'solid'}});
 applyPresentationChartFont(ch,{fontFamily:F});return ch;
}
const mods=spec.slide2.resultModules;
txt(s2,'第二章：历史源荷与环境典型日',29,283,470,38,23,C.navy,true,'center',C.pale);
const season=mods[0].visuals[0];season.xTitle='季节';nativeChart(s2,season,31,333,462,307,'0.0000',20);
txt(s2,'最高：夏季 1.6740',39,660,450,44,27,C.navy,true,'center',C.pale);
txt(s2,'设备电流与环境温度\n热老化与日寿命损失\n六项指标与AHP加权',55,714,410,96,24,C.ink,false,'center');
txt(s2,'同时刻画重载损伤与轻载利用不足',28,823,471,38,22,C.navy,true,'center',C.pale);
txt(s2,'有序充电：储能容量减少27.96%',532,283,548,37,23,C.navy,true,'center',C.pale);
let v=mods[1].visuals[0];v.xTitle='EV充电方式';nativeChart(s2,v,545,329,530,224,'0.00',19);
txt(s2,'退役电池：年净成本降低46.90%',532,571,548,37,23,C.navy,true,'center',C.pale);
v=mods[1].visuals[1];v.xTitle='电池类型（εev = 0.8）';nativeChart(s2,v,545,610,530,204,'0.00',19);
txt(s2,'短时治理综合得分：1.7258 → 0.2479',532,824,548,37,22,C.navy,true,'center',C.pale);
const table=mods[2].visuals[1],vals=[table.headers,...table.rows];
const t=s2.tables.add({rows:vals.length,columns:2,left:1116,top:283,width:525,height:168,values:vals,columnWidths:[165,360]});
t.borders.assign({fill:'#91B7D4',width:1,style:'solid'});
for(let r=0;r<vals.length;r++)for(let c=0;c<2;c++){const cell=t.getCell(r,c);cell.fill=r===0?'#DCEEFF':r%2?'#FFFFFF':'#F2F8FD';cell.text.style={typeface:F,fontSize:21,color:r===0?C.navy:C.ink,bold:r===0,alignment:'center',verticalAlignment:'middle',insets:{left:4,right:4,top:3,bottom:3}}}
v=mods[2].visuals[0];v.xTitle='载流设备';nativeChart(s2,v,1111,464,532,288,'0.00',18);
txt(s2,'年规划成本：142.63万元',1114,752,529,33,24,C.navy,true,'center',C.pale);
txt(s2,'综合得分：43.1630 → 0.3638\n部分设备仍略高于24 h参考值',1114,796,529,64,22,C.navy,true,'center',C.pale);
s2.speakerNotes.textFrame.setText('Source: '+spec.meta.sourcePath+'\nAssessment: PDF p.35 Table2-1 scores spring1.5978/summer1.6740/autumn1.5569/winter1.5828. Short-term: Tables3-5/3-6 PDF pp.53/55 capacities19.74/27.40 MWh; reduction=(27.40-19.74)/27.40=27.96%. PDF pp.51/53 EV simulation differs from Chapter2, baseline1.7258; PDF p.56 post-treatment0.2479. Net cost: Table3-7 p.58 new298.65 and retired158.57 wan CNY/year, same εev=.8; reduction46.90%. Long-term: p.71 constructed growth, not a forecasting validation; p.73 station14 3150kVA, transformer2500 to3150kVA, LGJ-120 18.988km, annual planning142.63. PDF p.74 Feq before125.25/115.57/113.12 h and after23.11/25.12/25.95 h, score43.1630 to.3638. Values above24h prevent a claim of full elimination. Annual storage net cost651.76 is not plotted or used for savings because its accounting differs. All numbers are reported or arithmetically derived from the thesis; not independently reproduced.');
await fs.writeFile(B+'/diagram-coverage.json',JSON.stringify(coverage,null,2),'utf8');
await fs.writeFile(B+'/formula-manifest.json',JSON.stringify({sourcePptx:path.join(ROOT,'output/配电网双向重过载_两页图形版.pptx'),formulas:manifest},null,2),'utf8');
await (await PresentationFile.exportPptx(P)).save(B+'/draft.pptx');
console.log('Exported 2 slides with native method graph, 4 charts and table');

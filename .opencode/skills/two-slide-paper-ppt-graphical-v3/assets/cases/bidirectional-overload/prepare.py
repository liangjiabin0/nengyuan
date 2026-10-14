from pathlib import Path
import json,hashlib,sys
ROOT=Path(__file__).parent;B=ROOT/'build';B.mkdir(exist_ok=True)
SK=ROOT.parents[2]
if len(sys.argv)!=2:raise SystemExit('usage: prepare.py path/to/20261010170602.pdf')
SOURCE=Path(sys.argv[1]).resolve()
if hashlib.sha256(SOURCE.read_bytes()).hexdigest()!='6c9fd587da8bad65260d82ddb968f520bba292d77afb95d174fcb85830d90f83':raise SystemExit('Source differs from validated thesis. Re-read and adapt the case instead of reusing these claims.')
TEMPLATE=SK/'assets/reference-pptx/图形框架基准/02_GFM变流器_分层功率再分配.pptx'
def save(n,d):(B/n).write_text(json.dumps(d,ensure_ascii=False,indent=2),encoding='utf-8')
G={'schemaVersion':1,'profile':'operation','nodes':[],'edges':[],'mechanisms':[],'formulaLinks':[]}
L={'canvas':{'width':1672,'height':941},'contentFrame':{'x':18,'y':230,'w':1636,'h':656},'diagramFrame':{'x':18,'y':230,'w':1636,'h':656},'fontFamily':'Microsoft YaHei','fontSize':24,'nodes':{},'edges':{}}
def node(id,typ,label,ref,x,y,w,h,glyph):
 G['nodes'].append(dict(id=id,type=typ,label=label,evidenceRef=ref));L['nodes'][id]=dict(x=x,y=y,w=w,h=h,glyph=glyph)
def edge(id,a,b,kind,label,ref,pts,lb):
 G['edges'].append(dict(id=id,**{'from':a,'to':b},kind=kind,label=label,evidenceRef=ref));L['edges'][id]={'points':pts,'labelBox':dict(zip(['x','y','w','h'],lb)),'fontSize':20}
node('pv','device','分布式光伏','PDF p.24 Fig.2-1',40,282,140,105,'solar')
node('load','device','EV与负荷','PDF p.24 Fig.2-1',280,282,160,105,'load')
node('network','bus','配变 / 线路','PDF pp.24,27–32',135,430,230,70,'bus')
node('thermal','operation','电流、环境温度\n热模型与老化速率','PDF pp.28–30',70,548,355,78,'process')
node('assessment','operation','日寿命损失 / 六项指标','PDF pp.30–35',70,675,355,68,'data')
node('regime','decision','治理\n类型','PDF pp.22–23',472,550,136,102,'decision')
node('users','agent','用户选择','PDF pp.39–41',650,296,155,105,'user')
node('logit','operation','Logit\n响应度 εev','PDF pp.40–41',895,302,180,86,'process')
node('rbess','optimizer','AIW-PSO\n配置与充放电','PDF pp.46–50',1180,302,215,86,'optimizer')
node('battery','device','退役储能','PDF pp.42–50',1488,290,145,116,'battery')
node('clusters','input','DPV 集群\nK-means','PDF pp.60–62',650,610,190,111,'solar')
node('collection','optimizer','汇集站\n选址定容','PDF pp.62–65',930,616,185,90,'optimizer')
node('expansion','optimizer','配变 / 线路\n扩容','PDF pp.65–70',1210,616,185,90,'optimizer')
node('plan','output','汇集＋扩容','PDF pp.69–73',1488,610,145,111,'bus')
edge('pv-power','pv','network','power','光伏出力','PDF p.24',[[110,387],[110,411],[192,411],[192,430]],[23,398,115,30])
edge('load-power','network','load','power','供电功率','PDF p.24',[[310,430],[310,411],[360,411],[360,387]],[340,398,118,30])
edge('measure','network','thermal','information','时序运行状态','PDF pp.28–30',[[250,500],[250,548]],[270,507,153,28])
edge('aging','thermal','assessment','data','累积损伤','PDF pp.29–32',[[250,626],[250,675]],[270,639,150,30])
edge('diagnosis','assessment','regime','information','风险诊断','PDF pp.22–23,33',[[425,709],[452,709],[452,601],[472,601]],[440,717,130,29])
edge('short','regime','users','decision','短时治理','PDF pp.22–23,37',[[540,550],[540,348],[650,348]],[543,303,105,30])
edge('long','regime','clusters','decision','长期治理','PDF pp.22–23,60',[[540,652],[540,665],[650,665]],[543,682,105,30])
edge('utility','users','logit','information','电价 / 等待','PDF pp.39–41',[[805,348],[895,348]],[792,405,132,30])
edge('ev-profile','logit','rbess','data','混合充电负荷','PDF pp.41,46',[[1075,345],[1180,345]],[1069,395,161,30])
edge('storage-plan','rbess','battery','decision','容量 / 出力','PDF pp.49–50',[[1395,345],[1488,345]],[1370,415,165,30])
edge('candidate','clusters','collection','data','候选汇集点','PDF pp.61–62',[[840,665],[930,665]],[826,733,145,30])
edge('net-load','collection','expansion','iteration','修正净负荷','PDF p.70',[[1115,651],[1210,651]],[1100,579,145,30])
edge('capacity','expansion','collection','iteration','更新容量边界','PDF p.70',[[1302,706],[1302,741],[1022,741],[1022,706]],[1087,747,185,28])
edge('joint-plan','expansion','plan','decision','联合方案','PDF pp.70,73',[[1395,661],[1488,661]],[1383,733,130,30])
edge('short-review','battery','assessment','feedback','短时治理后再评估','PDF p.56',[[1633,348],[1646,348],[1646,879],[438,879],[438,722],[425,722]],[697,855,345,26])
edge('long-review','plan','assessment','feedback','长期治理后再评估','PDF p.74',[[1560,721],[1560,843],[460,843],[460,697],[425,697]],[1175,849,400,26])
G['mechanisms']=[
 {'id':'two-regimes','kind':'branch','nodeIds':['regime','users','clusters'],'edgeIds':['short','long'],'evidenceRef':'PDF pp.22–23'},
 {'id':'joint-iteration','kind':'feedback','nodeIds':['collection','expansion'],'edgeIds':['net-load','capacity'],'evidenceRef':'PDF p.70 Fig.4-4'},
 {'id':'physical-system','kind':'physical-network','nodeIds':['pv','network','load'],'edgeIds':['pv-power','load-power'],'evidenceRef':'PDF p.24 Fig.2-1'},
 {'id':'short-reassessment','kind':'feedback','nodeIds':['assessment','regime','users','logit','rbess','battery'],'edgeIds':['diagnosis','short','utility','ev-profile','storage-plan','short-review'],'evidenceRef':'PDF pp.22–23,56'}]
F=[
 {'id':'aging','latex':r'F_{\mathrm{eq,h}}=\sum\nolimits_{n=1}^{N}V_{(n)}\Delta t','evidenceRef':'PDF p.29 Eq.2-7'},
 {'id':'response','latex':r'F_{\mathrm{order}}^{n}=\frac{e^{f_{n,1}^{\mathrm{charge}}}}{e^{f_{n,1}^{\mathrm{charge}}}+1},\quad\varepsilon_{\mathrm{ev}}=\frac{1}{N_{\mathrm{EV}}}\sum\nolimits_n F_{\mathrm{order}}^{n}','evidenceRef':'PDF p.41 Eqs.3-13,3-14; n abbreviates n_ev'},
 {'id':'short-objective','latex':r'\min\Delta F_{\mathrm{eq}},\quad\min E,\qquad E=C-I','evidenceRef':'PDF pp.43,46 Eqs.3-23,3-34'},
 {'id':'long-objective','latex':r'\min C_{\mathrm{gh}}=C_{\mathrm{hj}}+C_{\mathrm{kr}}','evidenceRef':'PDF p.69 Eq.4-19'}]
for f,ns in [('aging',['assessment']),('response',['logit']),('short-objective',['rbess']),('long-objective',['collection','expansion'])]:
 G['formulaLinks'].append({'formulaId':f,'nodeIds':ns,'edgeIds':[],'evidenceRef':next(v['evidenceRef'] for v in F if v['id']==f)})
L['formulas']={'aging':{'x':75,'y':764,'w':340,'h':48},'response':{'x':643,'y':452,'w':475,'h':53},'short-objective':{'x':1165,'y':452,'w':465,'h':39},'long-objective':{'x':660,'y':773,'w':422,'h':39}}
save('semantic-graph.json',G);save('diagram-layout.json',L)
def chart(id,title,cats,series,unit,lo,hi,step,ref):return {'type':'chart','id':id,'title':title,'categories':cats,'series':series,'xTitle':'场景 / 设备','yTitle':unit,'yMin':lo,'yMax':hi,'yMajorUnit':step,'evidenceRef':ref}
season=chart('season','四季典型日综合得分',['春','夏','秋','冬'],[{'name':'综合得分','values':[1.5978,1.6740,1.5569,1.5828]}],'综合得分',0,2,.4,'PDF p.35 Table2-1')
capacity=chart('storage','储能配置容量',['无序充电','80%有序'],[{'name':'储能容量','values':[27.40,19.74]}],'容量 / MWh',0,30,5,'PDF pp.53,55 Tables3-5,3-6')
cost=chart('netcost','储能年净成本',['新电池','退役电池'],[{'name':'年净成本','values':[298.65,158.57]}],'万元 / 年',0,350,70,'PDF p.58 Table3-7')
aging=chart('longaging','关键设备日寿命损失',['台区配变','线路20-21','线路31-32'],[{'name':'治理前','values':[125.25,115.57,113.12]},{'name':'治理后','values':[23.11,25.12,25.95]}],'日寿命损失 / h',0,150,30,'PDF p.74 text below Fig.4-8')
modules=[
 {'id':'assessment-results','caseIds':['historical-seasons'],'claimStatus':'validated','title':'评估：识别典型日风险差异','conclusion':'夏季风险最高，秋季最低\n同一指标支撑治理前后再评估','evidenceRef':'PDF pp.35–36','visuals':[season]},
 {'id':'short-results','caseIds':['short-summer'],'claimStatus':'validated','title':'短时：荷储协同减少配储需求','conclusion':'容量减少27.96%，年净成本降低46.90%\n综合得分 1.7258 → 0.2479','evidenceRef':'PDF pp.53–58','visuals':[capacity,cost]},
 {'id':'long-results','caseIds':['long-growth'],'claimStatus':'validated','title':'长期：汇集与扩容协同改造','conclusion':'综合得分 43.1630 → 0.3638\n部分设备仍略高于24 h参考值','evidenceRef':'PDF pp.73–74','visuals':[aging,{'type':'table','headers':['决策','方案'],'rows':[['汇集变','节点14 / 3150 kVA'],['台区配变','2500 → 3150 kVA'],['汇集线路','LGJ-120 / 18.988 km']],'evidenceRef':'PDF p.73 Section4.4.2'}]}
]
spec={'meta':{'paperTitle':'配电网双向重过载量化评估与分阶段协同治理策略研究','paperType':'planning','documentKind':'thesis','contributionMapPath':'contribution-map.json','sourcePath':str(SOURCE),'templatePptx':str(TEMPLATE),'slideSize':L['canvas'],'fontFamily':'Microsoft YaHei'},
 'slide1':{'title':'1. 双向重过载：量化评估与分阶段协同治理','summaryRuns':[{'text':'以载流设备累积寿命损失量化风险，按问题持续性选择治理路径：短时采用EV–退役储能协同，长期采用光伏汇集与网络扩容。'}],'methodModelPath':'planning-model.md','semanticGraphPath':'semantic-graph.json','diagramLayoutPath':'diagram-layout.json','formulas':F,'panels':[{'title':'量化评估','conclusion':'共同评价基础','formulaIds':['aging'],'evidenceRef':'Chapter2'},{'title':'短时治理','conclusion':'柔性调控','formulaIds':['response','short-objective'],'evidenceRef':'Chapter3'},{'title':'长期规划','conclusion':'结构改造','formulaIds':['long-objective'],'evidenceRef':'Chapter4'}]},
 'slide2':{'title':'2. IEEE 33节点算例：评估、短时调控与长期规划','summaryRuns':[{'text':'三项工作分别验证：季节风险可区分，有序充电降低储能配置需求，汇集–扩容缓解长期重过载；各章采用对应场景与评价口径。'}],'resultModules':modules}}
save('spec.json',spec)
M={'schemaVersion':1,'sourceStructure':[{'chapter':str(i),'role':'core','contributionId':cid,'evidenceRef':ref} for i,cid,ref in [(2,'assessment','PDF pp.24–36'),(3,'short','PDF pp.37–59'),(4,'long','PDF pp.60–75')]],
 'contributions':[{'id':id,'title':title,'evidenceRef':ref,'methodNodeIds':ns,'resultModuleIds':[result],'validationStatus':'simulated'} for id,title,ref,ns,result in [('assessment','热老化量化评估','Chapter2',['thermal','assessment'],'assessment-results'),('short','EV-RBESS短时治理','Chapter3',['logit','rbess','battery'],'short-results'),('long','汇集-扩容长期规划','Chapter4',['clusters','collection','expansion'],'long-results')]],
 'relations':[{'kind':'alternative','decisionNodeId':'regime','targetNodeIds':['users','clusters'],'evidenceRef':'PDF pp.22–23 Section1.3'}],
 'cases':[{'id':'historical-seasons','inputStatus':'historical','description':'第二章历史源荷与气象典型日；夏季分数1.6740','evidenceRef':'PDF pp.33–35'}, {'id':'short-summer','inputStatus':'constructed','description':'第三章EV混合充电模拟；无序基线1.7258，主要治理εev=0.8','evidenceRef':'PDF pp.51–56'}, {'id':'long-growth','inputStatus':'constructed','description':'第四章新增6个DPV、4个EV站和20%基荷；未采用灰色预测生成算例','evidenceRef':'PDF p.71'}], 'quantities':[], 'comparisons':[]}
for id,value,metric,unit,basis,horizon,case,ref in [
 ('capacity0',27.40,'installed-storage-capacity','MWh','rated-capacity','configuration','short-summer','Table3-6'),('capacity08',19.74,'installed-storage-capacity','MWh','rated-capacity','configuration','short-summer','Table3-5'),
 ('costnew',298.65,'annual-net-cost','wan-CNY/year','investment-minus-benefits','annual','short-summer','Table3-7'),('costretired',158.57,'annual-net-cost','wan-CNY/year','investment-minus-benefits','annual','short-summer','Table3-7'),
 ('longplan',142.63,'annual-planning-cost','wan-CNY/year','collection-plus-expansion-cost','annual','long-growth','Table4-3'),('longstorage',651.76,'annual-net-cost','wan-CNY/year','investment-minus-benefits','annual','long-growth','PDF p.74')]:
 M['quantities'].append(dict(id=id,value=value,metric=metric,unit=unit,basis=basis,horizon=horizon,caseId=case,evidenceRef=ref))
M['comparisons']=[{'id':'capacity-saving','left':'capacity0','right':'capacity08','mode':'percent-reduction','value':27.96,'evidenceRef':'PDF p.56'}, {'id':'net-cost-saving','left':'costnew','right':'costretired','mode':'percent-reduction','value':46.90,'evidenceRef':'PDF pp.58,76'}]
save('contribution-map.json',M)
(B/'planning-model.md').write_text('''# 双向重过载分阶段协同治理模型记录

来源：20261010170602.pdf，85页。PDF页码比正文页码多13页。

第2章基于电流、环境温度、设备热模型及热老化速率计算配变/线路日寿命损失，以24h为日参考值，构建重载/轻载风险后果和比例6项指标，再采用AHP权重线性加权。综合分数不是风险概率。

第3章先以Logit及平均响应度描述EV无序/有序混合充电，再配置RBESS。目标为最小化寿命损失偏离24h的绝对值总和与年净成本，通过模糊隶属度、SOC罚函数和AIW-PSO求解。电压、线路和配变负载、SOC及能量平衡约束保留。容量衰减需要补偿。

第4章地理位置/装机容量/反向潮流贡献聚类筛选汇集点；汇集站选址容量和存量载流设备扩容共享潮流约束与运行边界。以年汇集成本加年扩容成本最小为目标，固定一方优化另一方，更新净负荷，按成本变化率≤1%或50次停止。仅表示文中交替求解，不增强为已证明全局最优。灰色预测是提出的输入构造方法，算例实际直接扩展资源与基荷。

三项贡献组成评估、短时或长期治理、再评估的概念闭环，两种治理并非依次执行。长短期分别采用不同场景和成本口径。核心图形、公式与数值的精确来源见spec.json、semantic-graph.json和contribution-map.json。
''',encoding='utf-8')
(B/'visual-design-spec.md').write_text('''# 视觉设计

沿用GFM图形修订参考的1672×941画布、微软雅黑、深蓝标题、蓝色分隔线、浅蓝摘要、细蓝边框和底部总结框。复用实际母版与版式部件，替换论文内容。

第一页为共享评估链与上下两条治理支路。左侧光伏/负荷/配变线路及热老化；上支路EV用户、Logit、AIW-PSO与RBESS；下支路K-means、汇集、扩容、交替迭代。治理后回到同一评价节点。图形区优先，公式紧靠所属机制。短时和长期并列，不画串行执行箭头。

第二页三项贡献对应三个结果主题。原生柱图重绘原文精确数据；季节评分和第三章无序基线分开；中区储能减容和净成本比较口径一致；右区方案原生表格和三个设备寿命损失原生柱图，保留略高于24h的边界。142.63年规划成本独立展示，不与651.76年净成本计算降幅。
''',encoding='utf-8')
save('source-index.json',{'sourcePath':str(SOURCE),'sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'pdfPages':85,'printedPageOffset':13,'sections':M['sourceStructure']})
save('evidence-ledger.json',{'source':str(SOURCE),'method':G,'results':modules,'boundaries':['第二章1.6740与第三章1.7258不得混用','GM(1,1)未用于第4章算例预测验证','142.63年规划成本与651.76年净成本不可计算降幅','23.11、25.12、25.95小时是接近24小时，不是全部低于参考值','汇集模型MILP与集成MINLP线性化细节未充分展示，幻灯片不强化全局最优保证'],'comparisons':M['comparisons']})
print('Prepared graph, layout, 3-contribution map and sourced data')

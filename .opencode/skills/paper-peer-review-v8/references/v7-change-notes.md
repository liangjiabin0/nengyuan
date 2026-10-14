# v7 更新：人工反馈校准与模型核验

基于用户提供的 v5 核心评审流程，保留工作区 v6 的分类、ESOPT/Modelica、文献获取与两页PPT集成。本次只增强人工反馈重评及可复用核验规则；完整评审的两页PPT功能保留。

- 新增 references/power-system-review-memory.md，按适用条件组织概率变换、分段实现、容量折算、费用分摊、匿名资料及证据要求。
- 新增 scripts/extract_review_feedback.py，分别提取接受修订正文、插入/删除及评论锚点。
- 新增 scripts/render_paired_review.py，共用内容块生成Markdown/Word并检查保存后的段落、表格和原生公式；复杂LaTeX另用可靠转换器并渲染核验。
- 符号表最多三项且不凑数；区分含义缺失、数值缺失和模型歧义。
- 文献新增期刊字段；未知投稿日期使用null。
- 重评按用户请求的产物范围；JSON及打包器支持明确的ppt_required=false与Markdown报告。
- Markdown/Word采用同一规范内容并逐页核验原生数学对象。

记忆不包含两篇论文身份、私有原文、原始人工意见或算例数据。科学经验是检查规则，不是默认判定论文有错误。

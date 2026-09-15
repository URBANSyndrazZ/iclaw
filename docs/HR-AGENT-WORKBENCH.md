# iclaw HR Agent Workbench

iclaw 的 HR Agent 工作台是主业务入口，用于解决没有 Moka/北森时的技术岗位招聘协作问题。
它复用 Pi Agent Runtime 的 host-side 结构化查询能力做简历解析与诊断，并把受控
HR 查询、阶段修改和飞书同步暴露给全局聊天；Runtime 底层仍保持通用平台能力。

## 场景闭环

1. HR 创建岗位 JD，录入职责、硬性要求、技术栈和优先条件。
2. 简历通过本地批量上传（最多 20 个）或 iclaw 服务端 HTTPS 直链导入；上传只建档和抽取文本。
3. HR 在候选人中心或岗位详情手动触发单人/批量 AI 匹配。
4. 系统按 JD 和已激活岗位规则生成匹配评分、证据、缺失能力、矛盾点和推荐结论。
5. HR 获得 5-8 个初面问题，用于验证真实经历、项目深度和 JD 缺口。
6. 技术初筛、一面、二面、三面、谈薪、Offer、关闭状态在看板中推进。
7. 一面、二面、三面反馈以 JD 为主、反馈为辅分析；有效偏差先生成规则草稿，HR 审核激活后才影响后续评分。
8. 候选人和流程状态幂等写入飞书多维表格，用于跨团队人才库管理。
9. 岗位级诊断基于内部候选人和面试数据给出漏斗、薪酬、JD 适配和市场信号推断。

## 架构边界

`/` 和未知路由默认进入 `/hr`；登录后主导航提供 `HR 工作台`、`HR 助手` 和 `设置`。
智能体、能力库、任务、用量、账单和渠道等平台能力从设置页的高级能力区进入。HR 页面
保持为独立工作台，不作为聊天视图的内嵌看板。

| 层     | 位置                                         | 职责                                   |
| ------ | -------------------------------------------- | -------------------------------------- |
| Schema | `src/db.ts` + `src/hr/store.ts`              | HR 领域表、owner 隔离、CRUD 与审计     |
| API    | `src/routes/hr.ts`                           | `/api/hr/*` REST 接口和鉴权            |
| AI     | `src/hr/ai.ts`、`src/hr/analysis-service.ts` | 结构化 prompt、Zod 校验、分析任务状态  |
| 导入   | `src/hr/import.ts`                           | 上传、HTTPS 直链下载、文本抽取与去重   |
| 飞书   | `src/hr/feishu.ts`                           | Bitable upsert、幂等同步、错误状态     |
| UI     | `web/src/pages/hr/`                          | 总览、岗位库、候选人中心、问题库与诊断 |

HR API 请求集中在 `web/src/pages/hr/api.ts`，由 `hrApi` 统一封装候选人、简历、JD、规则、
AI 任务和飞书配置接口；页面不再各自解释不同的字段名或状态枚举。

所有 HR 数据带 `owner_user_id`。候选人、简历、分析结果和飞书配置均不能跨用户访问。
简历文件保存在 `data/hr/resumes/`，只允许通过鉴权 API 下载；日志不输出手机号、邮箱或完整简历。

### 单机演示运行时

无 Docker 的 Windows/macOS 面试演示环境可设置 `ICLAW_SINGLE_HOST_MODE=true` 后重启后端。
该开关会让成员 Home 的 Agent runtime 使用 host runner，解决普通成员工作台因缺少 Docker
而进入重试上限的问题。它只放宽 Agent runtime；脚本任务、host 目录挂载等管理员级 host
权限仍保持默认限制。演示结束后请关闭开关并重启。

### 信息架构

- `/hr`：工作台总览，展示活跃岗位、候选人总数、待初筛、面试中、AI 分析失败、待处理事项、最近候选人和带来源标签的最近操作。
- `/hr/jobs`：岗位库，提供搜索、状态筛选、新建岗位和岗位卡片统计。
- `/hr/jobs/:jobId`：岗位详情，支持修改 JD 标题/内容，并保留候选人漏斗、岗位诊断和导入入口。
- `/hr/candidates`：候选人中心，支持岗位、阶段、来源、搜索和人才库筛选。
- `/hr/candidates/:candidateId`：候选人详情，承载简历、匹配证据、面问题、反馈、阶段流转和飞书同步。
- `/hr/questions`：面试问题库，聚合 HR 面问题、追问理由和关注信号。
- `/hr/analytics`：诊断看板，展示阶段转化、岗位风险、JD 覆盖缺口、反馈新增要求和 AI 任务状态。
- `/hr/feishu`：飞书绑定页，用于配置 Feishu channel account、Bitable 表格、字段映射，并查看同步状态。
- `/hr` 总览提供 HR 助手入口，复用全局聊天；聊天工具通过 host-side IPC 访问当前
  Workspace 的 HR 数据，不会跨 owner 查询。

## API 概览

- `GET|POST /api/hr/jobs`
- `GET /api/hr/jobs?with_stats=true`
- `GET /api/hr/jobs?with_stats=true&include_deleted=true`
- `DELETE /api/hr/jobs/:jobId`
- `POST /api/hr/jobs/:jobId/restore`
- `GET /api/hr/overview`
- `GET /api/hr/agent-activity`
- `GET|PUT /api/hr/jobs/:jobId`
- `POST /api/hr/jobs/:jobId/market-analysis`
- `GET /api/hr/candidates`
- `GET /api/hr/questions`
- `GET /api/hr/analytics`
- `GET /api/hr/analysis-jobs?status=queued|running|completed|failed|retrying`
- `POST /api/hr/analysis-jobs/:jobId/retry`
- `POST /api/hr/jobs/:jobId/analyze-pending`
- `POST /api/hr/candidates/import`
- `POST /api/hr/candidates/import/link`
- `GET|POST /api/hr/jobs/:jobId/rules`
- `GET|PATCH /api/hr/candidates/:candidateId`
- `POST /api/hr/candidates/:candidateId/reanalyze`
- `POST /api/hr/candidates/:candidateId/feedback`
- `GET /api/hr/resumes/:resumeId/download`
- `GET /api/hr/resumes/:resumeId/view`
- `DELETE /api/hr/resumes/:resumeId`
- `POST /api/hr/candidates/:candidateId/resumes/:resumeId/replace`
- `GET|PUT /api/hr/feishu/config`
- `GET /api/hr/feishu/status`
- `POST /api/hr/feishu/test`
- `POST /api/hr/candidates/:candidateId/feishu/sync`

### JD 生命周期

- JD 支持 `active`、`paused`、`closed` 三种状态，并可设置 `expires_at`。
- 到期扫描在服务启动时执行一次，之后每小时执行一次；已到期的 `active` 岗位自动
  变为 `closed`，并写入 `job_expired` 审计日志。暂停岗位到期后保持 `paused`。
- 默认岗位列表、总览、诊断和 Agent 查询只包含未软删除岗位。
- `DELETE /api/hr/jobs/:jobId` 是软删除；候选人、简历、评分和反馈历史保留。
  软删除后的岗位不允许继续导入候选人，可通过恢复接口或岗位库恢复。
- 软删除岗位不允许通过岗位更新接口修改；默认列表、总览、诊断和 Agent 查询都会排除它。

### HR Agent 聊天工具

全局聊天提供以下受控工具，全部通过 host-side IPC 使用当前 Workspace owner：

| 工具                           | 用途                                           |
| ------------------------------ | ---------------------------------------------- |
| `hr_list_jobs`                 | 查询岗位和到期/过期/软删除状态                 |
| `hr_get_job`                   | 读取完整 JD、结构化要求、漏斗和岗位规则摘要    |
| `hr_get_job_stats`             | 查询岗位漏斗和 AI 任务状态计数                 |
| `hr_analyze_job`               | 只读分析 JD 质量，不改写 JD                    |
| `hr_analyze_resume_preview`    | 用聊天简历附件和临时 JD 做只读匹配预览，不落库 |
| `hr_list_candidates`           | 查询候选人业务摘要                             |
| `hr_get_candidate`             | 查询面试进度、评分、推荐和匹配证据             |
| `hr_search_aggregate`          | 一次搜索岗位和候选人业务摘要                   |
| `hr_start_candidate_analysis`  | 启动候选人持久化分析队列并返回任务 ID          |
| `hr_start_job_analysis`        | 启动岗位漏斗/市场分析并返回任务 ID             |
| `hr_get_analysis_job`          | 追踪候选人分析或市场分析状态                   |
| `hr_update_candidate`          | 经确认后更新姓名、阶段、人才库和摘要           |
| `hr_list_interview_rounds`     | 查询面试轮次和反馈摘要                         |
| `hr_submit_interview_feedback` | 记录面试反馈并触发分析和 JD 规则草稿           |
| `hr_sync_candidate_to_feishu`  | 手动同步候选人 payload 到 Bitable              |
| `hr_update_job`                | 经用户确认后更新标题、JD 和结构化要求          |

工具返回姓名、岗位、阶段、评分、摘要、推荐和面试轮次，不返回手机号、邮箱或简历全文。
候选人摘要输出会进一步脱敏邮箱和 7 位以上连续数字。`hr_search_aggregate` 只搜索
岗位标题/部门/地点/级别/薪资，以及候选人姓名/岗位标题/摘要/推荐结论；它不搜索
邮箱、手机号、简历原文或 profile，结果包含总数和截断标记。
候选人姓名解析到多条记录时，Agent 必须请求用户确认；候选人姓名/阶段/人才库/摘要
修改必须显式确认，并使用 `expected_updated_at` 做并发控制。人才库变化写
`candidate_talent_pool_updated`，摘要变化写 `candidate_summary_updated`。姓名变化
写入 `candidate_name_updated`，阶段变化写入 `candidate_stage_updated`，任一变化后
会复用候选人飞书同步。`expected_updated_at` 取自候选人摘要中的 `updatedAt`。
简历文件名导入时先做姓名清理并标记 `filename`；AI 解析只在
`filename` 来源下回填并标记 `parsed`；页面或 Agent 手动修正标记 `manual`。

聊天简历附件支持 PDF、DOC、DOCX、TXT 和 MD，最大 10MB。上传进入 owner 隔离的
临时目录，24 小时后清理；临时分析完成后立即删除文件。消息和 Agent 只拿到
`attachment_id`、文件名、MIME 和大小，不把简历原文注入上下文。
`hr_analyze_resume_preview` 接收 `attachment_id` 和任意 `jd_text`，返回和落库
分析相同的 `resume_scoring_v2` 总分与 breakdown；不创建岗位、候选人、简历记录、
AI 队列任务或飞书记录，只写 `resume_preview_analyzed` 审计元数据。

`hr_get_job` 可以返回 JD 原文，因为 JD 不属于候选人 PII。JD 质量分析返回优势、
模糊点、缺失要求、风险和改进建议，只写 `job_analyzed` 审计，不覆盖 JD。
`hr_update_job` 使用 `expected_updated_at` 做乐观并发控制；JD 文本变化会归档现有
draft/active 岗位规则，标题变化会复用候选人飞书同步并把成功/失败计数返回给 Agent。
第一版聊天不能通过 `hr_update_job` 修改岗位状态、到期时间、软删除或恢复。

HR Agent 能力由 workspace 级 `hr_agent_enabled` 控制，默认启用；工作区设置弹窗可修改，
保存时安全重启 runner，让下一次会话只看到新工具集合。关闭后 runner 不注册
`hr_*` 工具，host-side IPC 也会拒绝 HR capability 请求。总览的“最近操作”读取脱敏
审计摘要，用 `聊天 / 页面 / 系统` 区分来源，展示候选人更新、阶段变更、飞书同步、
JD 分析/更新和岗位生命周期变更。

`/hr` 总览提供“导出 CSV”。`GET /api/hr/overview/export.csv` 只导出工作台汇总：
核心指标、岗位状态/到期/阶段人数和 AI 任务状态/类型计数；不导出候选人姓名、
联系方式、简历、评分明细、最近操作明细或人才库候选人明细。

完整请求和响应结构以 `src/hr/schemas.ts`、`src/routes/hr.ts` 与 `docs/API.md` 为准。

## 手动 AI 匹配与岗位规则迭代

- 上传成功后候选人为 `pending`，不会写入虚构评分；AI 解析失败或模型输出非法时为 `failed` 并保留脱敏错误。
- `reanalyze` 会在后台任务中顺序执行简历解析、结构化简历/JD 评估、评分器计算和 HR 面问题生成；接口立即返回
  `202` 与 `running` 状态，前端轮询候选人状态；成功后更新评分、推荐、风险和问题。
- 候选人完整分析写入持久化 `hr_analysis_jobs` 队列。服务启动时会把上一个进程遗留的
  `running` 任务恢复为 `retrying`；失败任务按指数退避自动重试，最多 3 次，也可在
  `/hr/analysis-jobs` 手动重试。
- 岗位详情可批量分析当前岗位的 pending/failed 候选人；候选人中心可单人触发。
- 面试反馈只在 `interview_1`、`interview_2`、`interview_3` 开放。包含新增要求、JD 缺口或矛盾点的反馈会生成 `draft` 规则版本。
- HR 激活规则后，旧 active 规则自动归档；后续匹配 prompt 会加入规则作为辅助校准，但 JD 始终优先。修改 JD 会归档当前 draft/active 规则。

## 简历导入契约

iclaw 内置服务端 HTTPS 直链导入，不再依赖外部 OpenCli/Boss 命令。输入为：

```json
{
  "job_id": "job-id",
  "source_url": "https://example.com/zhang-san.pdf",
  "candidate": { "full_name": "可选" }
}
```

服务端逐跳校验目标：只允许 HTTPS 443，拒绝内网、回环、本地和非 HTTPS 重定向；
DNS 解析到私网也拒绝。重定向最多 3 次，请求超时 30 秒，响应最大 10MB。
允许 PDF、DOC、DOCX、TXT 和 Markdown；已知 MIME 与扩展名不匹配或未知 MIME 会拒绝。
需要登录、验证码或动态页面才能访问的 Boss 链接不在支持范围内。

本地上传每次最多选择 20 个文件；链接和上传都复用同一套文件校验、文本抽取、AI 任务
入队与去重逻辑。导入不自动评分，需要 HR 手动触发 AI 分析。

导入会做同岗位去重：命中邮箱、手机号或简历 SHA-256 时复用已有候选人，并追加新简历版本。
HR 页面的 HTTPS 导入必须先选择岗位并填写简历直链；导入结果会显示候选人、
简历文件、来源链接和 AI 分析状态。

### 简历维护、姓名修正与 JD 编辑

- 上传文件名可能包含岗位、日期或平台后缀；候选人详情页可在导入后修正 `候选人姓名`，保存后自动同步飞书。
- 每份简历支持 `替换` 和 `删除`。替换成功后删除旧简历记录和受保护文件，追加新简历到目标候选人，并把 AI 状态重置为 `pending`；旧评分和面试历史保留为历史记录。
- 删除简历只删除该份简历，不删除候选人、匹配结果、问题库或反馈时间线。当候选人没有剩余简历时，飞书同步会把 `简历链接` 清空。
- 简历路径删除前会校验在当前 owner/candidate 的受保护目录内，避免路径逃逸；删除、替换、姓名修正和 JD 编辑都会写审计日志。
- 岗位详情可修改 JD 标题和内容。JD 文本变更会归档现有 draft/active 规则；标题变更后会按候选人逐条同步飞书，并在页面展示成功/失败数量。
- 候选人详情可手动填写、修改或清空一面/二面/三面面试官；面试官是自由文本，不关联平台账号，也不代表岗位级授权。保存后会同步飞书对应字段。
- 已关闭候选人可设置或清除保留期。到期数据只进入总览清理提示，不自动删除。
- 彻底删除必须输入候选人完整姓名。若存在飞书 record，先尝试删除远端；远端失败会中止本地删除。本地删除覆盖简历文件、评分、面问题、反馈、AI 任务和同步记录，审计保留数量与时间摘要。

### 简历在线查看

- 候选人详情页可打开 PDF 内嵌预览。
- TXT 和 Markdown 按纯文本预览，不渲染 Markdown/HTML，避免简历内容注入。
- DOC/DOCX 只提供下载，不在 MVP 中做格式转换。
- 预览和下载都走登录 API 并校验 owner；响应不暴露服务器保存路径。

## AI 分析约定

### resume_scoring_v2 评分标准

- 新落库匹配和聊天临时分析统一使用 `resume_scoring_v2`；模型不直接输出总分。
- Must-have 35%、Project fit 40%、Evidence quality 15%、Preferred 10%；每条矛盾
  或疑似编造扣 5 分，最多扣 15 分。
- Must-have 每条为 `met / partial / not_evident / contradiction`，对应 1 / 0.5 /
  0 / 0；Project fit 由角色领域、工作场景、复杂度规模和产出影响组成。
- Evidence quality 由具体技术、可验证结果和证据可追溯性组成。Preferred 评分方式
  与 Must-have 相同，但权重更低。
- 当 Project fit >= 85、Must-have >= 70、无核心硬性要求缺失且无疑似编造时，
  Must-have 权重降到 30%，Project fit 升到 45%。
- 结论映射：`>=85 strong_fit`，`70-84 fit`，`55-69 borderline`，`<55 not_fit`。
- 匹配记录写入 `score_standard` 和 `score_breakdown`；候选人写入
  `overall_score_standard`。旧分数自动显示为 `legacy`，不批量重算。

- 模型输出必须是 JSON，并通过 Zod schema 校验。
- 为避免长简历导致输出截断，HR prompt 限制了摘要和列表长度。如果模型仍返回不完整 JSON，
  系统会用一次更紧凑的输出要求重试；第二次仍失败则保留失败状态，不写入虚构评分。
- 针对第三方模型的宽松输出做了兼容归一化：数值可传字符串，列表可传字符串或数组，
  空列表不会导致失败；但模型仍必须返回一层 JSON 对象，关键评分和推荐等级必须有效。
- 如果分析失败，候选人页会显示包含分析步骤和字段路径的 schema 错误，例如
  `resume_parse schema failed: education.0 expected object`。可据此确认模型输出问题，
  再点击 `重新分析` 重试。
- 系统已兼容常见宽松 JSON：字符串评分、对象/字符串混合列表、数组形式的维度评分、
  包裹的问题列表和中英文推面建议。无法归一化的字段仍会标记失败，不写入虚构评分。
- 结构化评估中的证据必须来自简历原文；缺失能力、矛盾点和风险单独列出，总分由
  固定评分器计算。
- 面试反馈分析会区分：JD 已覆盖的能力、JD 未覆盖但被追问的能力、反馈与简历/JD 的矛盾。
- 岗位诊断只使用系统内 JD、候选人、阶段、反馈和拒绝原因，不调用实时薪酬行情接口。
- 可用 `ICLAW_HR_MODEL` 指定 DeepSeek 模型引用，例如 `deepseek-v4-flash` 或
  provider 要求的完整引用。必须在后端进程启动前设置变量；修改后重启后端才生效。
- 模型源和 API 凭证仍由 Pi 配置管理，HR 不单独保存密钥。AI 分析任务会记录实际使用的
  `model`，可用于确认新模型是否生效。
- 面试演示可设置 `ICLAW_HR_MOCK_MODEL=true`。该开关只在 HR AI 层生效，不会绕过
  Pi Agent Runtime 的模型传输层；简历解析、JD 匹配、面问题、反馈分析和岗位诊断
  仍会经过 Zod 校验、数据库落库和状态流转。启用后模型源显示为 `hr-mock-model`。
  演示后请设置为 `false` 或移除变量并重启后端。

### 演示数据

```bash
npm run seed:hr-demo -- <username>
```

脚本默认启用 mock 模型，读取 `data/jd/*.txt` 和 `data/resume/*`，创建岗位、导入简历、
执行 mock 分析，并补充一条面试反馈和一条待审核岗位规则。脚本可重复执行；已有同名
候选人且已有简历时会跳过。需要用真实模型分析时追加 `--with-model`，但请先确认
Pi Runtime 的模型凭证可用。

## 飞书同步

## 飞书配置流程

1. 在飞书开放平台创建自建应用，获取 App ID 和 App Secret。
2. 为应用开通多维表格读写权限，并发布/启用应用。
3. 在 Bitable 所在知识库或文档空间中，授权该应用访问目标多维表格。
4. 在多维表格中建好同步列；至少保留 `候选人ID` 列作为唯一键。
5. 进入 iclaw 渠道账号设置，创建/启用 Feishu channel account，保存 App ID/Secret。
6. 在 `/hr/feishu` 页面选择该账号，填写 Bitable App Token 和 Table ID。
7. 检查或修改字段映射，点击 `测试连接`，确认凭证、表访问和字段完整。
8. 保存配置后，先对一个候选人点击 `同步飞书` 验证；候选人状态变更和手动同步会写入飞书。

AI 分析完成不会自动同步飞书。候选人姓名修正、简历删除/替换、推面状态变更和手动同步会写入飞书；替换后的重新分析结果仍需 HR 再次同步或等待下一次状态变更。

默认映射包括：

| 内部字段         | 默认列名                                     |
| ---------------- | -------------------------------------------- |
| `candidate_id`   | 候选人ID（必填）                             |
| `full_name`      | 候选人                                       |
| `job_title`      | 岗位                                         |
| `stage`          | 阶段                                         |
| `score`          | 评分                                         |
| `recommendation` | 推荐结论（完整匹配理由，必须映射到文本字段） |
| `resume_url`     | 简历链接                                     |
| `source`         | 来源                                         |
| `updated_at`     | 更新时间（必须映射到文本字段）               |

同步使用候选人 ID 作为外部唯一键。若已有 record id，则更新记录；否则先搜索，再创建。
payload hash 未变化时跳过重复同步。失败会记录 `attempt`、`error` 和 `last_synced_at`。
`测试连接` 会读取 Bitable 字段列表并报告映射缺失，不会把测试结果伪装成同步成功。候选人没有剩余简历时，`resume_url` payload 为 `null`，用于清空飞书旧链接。

推荐结论不回填英文枚举。同步器会基于最新 JD 匹配的 `rationale` 清理 Markdown、代码块和多余空白，
写入带“匹配等级：强匹配 / 匹配 / 边界匹配 / 不匹配”前缀的完整中文理由，不再截断。评分只写数字；
没有评分时跳过评分字段，不发送空字符串。

同步前会读取 Bitable 字段类型并做安全转换：文本/单选/电话写文本，数字字段写数字，
链接字段写 `{ text, link }`。更新时间使用 UTC+8 文本，格式为
`YYYY年M月D日 HH:mm:ss`，例如 `2026年9月9日 12:30:45`；字段必须是文本类型。
一面/二面/三面面试官字段为可选映射，兼容文本或单选字段；清空后会同步为空。公式、
创建时间、修改时间等系统字段
不可写入；可选字段不存在时跳过，候选人 ID 字段不存在时同步失败。

Bitable 表必须至少包含 `候选人ID` 列，且运行 iclaw 的飞书应用需要对应多维表格的读写权限。

同步 payload 中的“阶段”使用中文显示值：待技术初筛、一面、二面、三面、谈薪、已发 Offer、
已入职、已淘汰、已放弃。iclaw 内部仍保存英文阶段枚举；字段映射继续使用 `stage` 内部 key。
HR 面问题只保存在 iclaw 的问题库和候选人详情页，不同步到飞书。“推荐结论”字段应使用 Bitable 文本字段；测试连接会识别误映射为单选等类型的问题，同步也会拒绝这类写入。

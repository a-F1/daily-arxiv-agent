# 每日 arXiv 九篇论文精读

一个自动生成中文论文精读并发布到 GitHub Pages 的静态站点。流水线从 arXiv 当日发布批次中为三个领域各选最多三篇论文，用每篇一次模型调用整理研究动机、核心方法、实验设置、主要结果与训练/计算资源；Astro 将 `data/reports/*.json` 构建为可浏览、可筛选、可全文检索的归档。

## 本地开发

要求 Node.js 22。

```bash
npm ci
npm exec astro dev
```

生产构建与搜索索引：

```bash
npm test
npm exec astro build
npm exec pagefind -- --site dist
npm exec astro preview
```

Pagefind 只在生产构建后生成。开发服务器中搜索对话框会显示友好的“索引尚未生成”提示，其他功能不受影响。

## 报告数据

每份报告存放在 `data/reports/YYYY-MM-DD.json`，并由
`src/schema/report.ts` 的 Zod schema 严格校验。新报告包含三个领域和最多九篇
论文，每篇论文的 motivation / method / experiment setup / results /
training resources 均为简短、有序的中文条目数组。流水线不再生成 research
idea、refinement、prior-art search 或 Claude/OpenAI debate。旧报告的字符串摘要
与历史 `domainResearch` 仍可读取；历史报告页可继续展示已有研究构想。

摘要和 provenance notes 的叙述字段必须使用简体中文。每个模型提示都包含统一语言合同，流水线还使用独立的中文
Zod schema 检查汉字占比并拒绝整段英文或常见繁体字；首次语言校验失败会进行
一次带明确错误原因的纠正重试。原始论文标题、作者、模型名、arXiv ID、URL、
BibTeX、公式和必要技术专名可保留原文，英文论文输入本身不参与输出语言校验。

报告日期严格表示 arXiv 的 **announcement/release batch date**，以
`America/New_York` 为时区，并以官方 RSS 每个 item 的 `pubDate` 为证据。
只纳入 `announce_type=new`（首次发布）与 `cross`（同批次跨分类发布）；
`replace`、`replace-cross` 和未知类型一律排除。API `submittedDate`、版本
`updated` 时间和抓取时间都不能替代 release date。每篇论文保存
`releaseDate`、`announcementType` 和 `releaseSourceUrl`，报告保存完整
`selectionPolicy`。某领域不足三篇时保留实际数量并记录缺口，不跨日回填。

在领域评分和每领域三篇配额之前，流水线执行两类硬排除。第一类
`safety-security-attack-defense-v1` 使用标题、摘要和 arXiv
分类进行确定性主题判断，覆盖 AI safety/alignment、security/cybersecurity、
attack/adversarial attack、jailbreak、prompt injection、poisoning、backdoor、
red teaming、defense/mitigation/guardrail 及对应中文主题。单独出现 `safe`、
一般统计 `robustness`、普通 detection 或 type-safe API 不会触发，除非同时存在
明确安全攻防语境。每次报告只保存排除总数及可审计 reason code 统计，不把被排除
论文展示为推荐内容，也不会因领域不足三篇而回填。第二类
`cloud-computing-v1` 排除以 cloud computing、cloud systems、cloud
infrastructure/platform/service、serverless/FaaS、cloud resource scheduling、
cloud workload、data center/datacenter、云计算、云平台、无服务器、云资源调度、
数据中心为研究主题的论文。仅把 cloud API 或 cloud storage 当工具、以及 point
cloud / 点云论文不会触发。报告分别记录安全攻防与云计算排除数量和可审计 reason
code。

仓库没有报告数据时仍能完成构建。周末、假日或官方空批次会快速生成
`releaseStatus=no-release` 的零论文报告且不调用模型。

## 自动化

`Daily arXiv research` 在 UTC 周一至周五 01:17、02:17、06:17 幂等检查，
覆盖纽约夏令时/冬令时、arXiv 审核延迟和 Actions 排队延迟。也可以手动触发并
指定日期。没有新 release 时不会调用模型；工作流只提交新的 `data/reports`。

在仓库设置中添加：

- Actions secret：`CURSOR_API_KEY`
- 可选模型变量：`CURSOR_SUMMARY_MODEL`（默认 `composer-2.5`，须在账户模型列表中可用）

`Build and deploy Pages` 在 `main` 更新或手动触发时执行测试、Astro 构建、Pagefind 索引并部署。首次使用前，在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。

若站点部署到自定义域名，请设置仓库变量或构建环境中的 `SITE_URL`。GitHub Pages 项目站点的子路径会根据 `GITHUB_REPOSITORY` 自动配置。

## 环境变量

复制 `.env.example` 为 `.env` 进行本地配置。`.env` 与流水线检查点默认不会进入版本控制。

流水线默认并行处理三个领域，并以 `MODEL_CONCURRENCY=3` 作为九个摘要调用的
全局上限。`SUMMARY_CONCURRENCY` 只限制摘要任务，仍受全局上限约束。
`MODEL_TIMEOUT_MS=600000` 为单次调用设置十分钟上限；
`MAX_PAPER_TEXT_CHARS=40000` 控制送入摘要模型的 PDF 关键章节长度。
默认预算为 `MAX_DAILY_RUNS=12`、`MAX_DAILY_TOKENS=2000000`，为最多九次正常摘要及有限重试保留余量。

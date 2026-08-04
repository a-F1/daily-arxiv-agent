# 每日 arXiv 研究智能体

一个自动生成中文研究简报并发布到 GitHub Pages 的静态站点。研究流水线筛选 arXiv 新论文，整理摘要、研究想法、可改进之处、争论点、参考资料和生成来源；Astro 将 `data/reports/*.json` 构建为可浏览、可筛选、可全文检索的归档。

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
`src/schema/report.ts` 的 Zod schema 严格校验。报告包含三个领域、每篇论文的
motivation / method / experiment setup / results / training resources，以及每个领域
独立的可行 idea、refine 历史、3–5 轮 Claude/OpenAI debate 和完整引用 ledger。

仓库没有报告数据时仍能完成构建，并显示空状态。

## 自动化

`Daily arXiv research` 在 UTC 周一至周五 01:17、02:17、06:17 幂等检查，
覆盖纽约夏令时/冬令时、arXiv 审核延迟和 Actions 排队延迟。也可以手动触发并
指定日期。没有新 release 时不会调用模型；工作流只提交新的 `data/reports`。

在仓库设置中添加：

- Actions secret：`CURSOR_API_KEY`
- Actions variables：`CURSOR_CLAUDE_MODEL`、`CURSOR_OPENAI_MODEL`（仅用于 debate，必须是当前 Cursor 账户可用的明确模型 ID）
- 可选模型变量：`CURSOR_SUMMARY_MODEL`、`CURSOR_IDEA_MODEL`（默认 `composer-2.5`，须在账户模型列表中可用）
- 可选 Actions variable：`OPENALEX_EMAIL`（OpenAlex polite pool）

`Build and deploy Pages` 在 `main` 更新或手动触发时执行测试、Astro 构建、Pagefind 索引并部署。首次使用前，在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。

若站点部署到自定义域名，请设置仓库变量或构建环境中的 `SITE_URL`。GitHub Pages 项目站点的子路径会根据 `GITHUB_REPOSITORY` 自动配置。

## 环境变量

复制 `.env.example` 为 `.env` 进行本地配置。`.env` 与流水线检查点默认不会进入版本控制。

流水线默认并行处理三个领域，并以 `MODEL_CONCURRENCY=3` 作为所有模型调用的
全局上限。`SUMMARY_CONCURRENCY` 只限制摘要任务，仍受全局上限约束。
`MODEL_TIMEOUT_MS=600000` 为单次调用设置十分钟上限；
`MAX_PAPER_TEXT_CHARS=40000` 控制送入摘要模型的 PDF 关键章节长度。
`DEBATE_MIN_ROUNDS` / `DEBATE_MAX_ROUNDS` 必须保持在 3–5 轮范围内。

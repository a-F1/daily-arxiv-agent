import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const isProjectPage = Boolean(process.env.GITHUB_ACTIONS && repository && !repository.endsWith(".github.io"));
const base = isProjectPage ? `/${repository}` : "/";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://example.com",
  base,
  output: "static",
  integrations: [sitemap()],
  trailingSlash: "always",
});

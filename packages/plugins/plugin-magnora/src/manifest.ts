import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CONFIG_SCHEMA } from "./config.js";
import { DB_NAMESPACE_SLUG, EXPORT_NAMES, JOB_KEYS, PAGE_ROUTE, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";
import { TOOL_DECLARATIONS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Magnora Marketing Ops",
  description:
    "Gmail (OAuth, drafts, approval-gated send), social channels (Facebook, Instagram, LinkedIn, X) with approval-gated publishing, affiliate provider reporting and an integrations/approvals dashboard.",
  author: "Magnora Marketing",
  categories: ["connector", "automation", "ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "activity.log.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: CONFIG_SCHEMA as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  database: {
    namespaceSlug: DB_NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.publishScheduled,
      displayName: "Publish approved & scheduled items",
      description: "Publishes approved social posts / sends approved emails whose scheduled time has passed, and retries transient failures.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: TOOL_DECLARATIONS,
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Magnora",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Magnora",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Magnora",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;

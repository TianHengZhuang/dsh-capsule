// 作用：把 Runtime 返回的 capsule.list_tools 结果映射为 DSH Tool Registry 所需的 Schema
export interface CapsuleToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export function parseToolSchemas(tools: unknown): CapsuleToolSchema[] {
  // 作用：校验并抽取 name/description/parameters；内部字段（capsule_id 等）不透出给模型
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && typeof t["name"] === "string")
    .map((t) => ({
      name: t["name"] as string,
      description: typeof t["description"] === "string" ? t["description"] : "",
      parameters: (t["parameters"] && typeof t["parameters"] === "object" ? t["parameters"] : {}) as Record<string, unknown>,
    }));
}

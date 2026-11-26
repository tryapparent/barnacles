export type RepositoryPolicy = { repository_name(value: string): string };

export function repository(value: unknown, policy: RepositoryPolicy): string {
  const name = typeof value === "string" ? policy.repository_name(value) : "";
  if (!name) throw Error("Expected owner/repository");
  return name;
}

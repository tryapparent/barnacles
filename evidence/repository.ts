export function repository(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[\w.-]+\/[\w.-]+$/.test(value) ||
      value.split("/").some((part) => part === "." || part === "..")) {
    throw Error("Expected owner/repository");
  }
  return value.toLowerCase();
}

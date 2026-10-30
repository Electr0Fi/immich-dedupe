import fs from "fs";

export function updateEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const linePattern = new RegExp(`^${key}=.*$`, "m");
    if (linePattern.test(content)) {
      content = content.replace(linePattern, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  fs.writeFileSync(envPath, content, "utf-8");
}


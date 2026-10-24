// shared/abi/*.json → src/abi/*.ts (viem'in tip çıkarımı için `as const`)
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "../../shared/abi");
for (const f of readdirSync(src).filter((f) => f.endsWith(".json"))) {
  const name = f.replace(".json", "");
  const abi = readFileSync(join(src, f), "utf8");
  writeFileSync(join(root, "../src/abi", `${name}.ts`), `// otomatik üretildi: npm run abi\nexport const ${name}Abi = ${abi.trim()} as const;\n`);
  console.log("abi:", name);
}

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const targetArg = value("target");
if (!targetArg) throw new Error("Supply --target=PATH; add --write to apply the preview");
const target = path.resolve(targetArg);
if (target === source || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) {
  throw new Error("Source and target must be separate repositories");
}
const write = args.includes("--write");
const git = (root, argv, options = {}) => execFileSync("git", ["-C", root, ...argv], {
  encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options,
});
const ref = args.includes("--index") ? null : git(source, ["rev-parse", "--verify", `${value("ref") ?? "HEAD"}^{commit}`]).trim();
const records = ref
  ? git(source, ["ls-tree", "-r", "-z", ref]).split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/);
    if (!match) throw new Error("Only ordinary files and symlinks are supported");
    return { mode: match[1], hash: match[2], file: match[3] };
  })
  : git(source, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/);
    if (!match) throw new Error("Resolve index conflicts before exporting");
    return { mode: match[1], hash: match[2], file: match[3] };
  });
const blob = (record) => git(source, ["cat-file", "blob", record.hash], { encoding: null });
const configRecord = records.find((record) => record.file === "publication.json");
if (!configRecord) throw new Error("The selected revision has no publication.json");
const config = JSON.parse(blob(configRecord));
const upstream = git(source, ["rev-parse", "--verify", `${config.upstreamBase}^{commit}`]).trim();
if (ref) git(source, ["merge-base", "--is-ancestor", upstream, ref]);
const allowed = new Set(config.benchmarkFiles.map((file) => `benchmark/${file}`));
const exported = records.filter(({ file }) => !file.startsWith("benchmark/") || allowed.has(file));
for (const file of allowed) if (!exported.some((record) => record.file === file)) throw new Error(`Missing required check: ${file}`);
const hashes = [...new Set(exported.map((record) => record.hash))];
const batch = git(source, ["cat-file", "--batch"], {
  input: hashes.join("\n") + "\n", encoding: null,
});
const objects = new Map();
let offset = 0;
for (const hash of hashes) {
  const end = batch.indexOf(10, offset);
  const header = batch.subarray(offset, end).toString().match(/^([a-f0-9]+) blob (\d+)$/);
  if (!header || header[1] !== hash) throw new Error("Invalid Git object response");
  const size = Number(header[2]);
  objects.set(hash, batch.subarray(end + 1, end + 1 + size));
  offset = end + 2 + size;
}
const contents = new Map(exported.map((record) => {
  let bytes = objects.get(record.hash);
  if (record.file === ".gitignore") bytes = Buffer.from(bytes.toString("utf8").replace(
    /# BEGIN LOCAL DEVELOPMENT\r?\n[\s\S]*?# END LOCAL DEVELOPMENT\r?\n?/g, "",
  ).trimEnd() + "\n");
  return [record.file, bytes];
}));
const safe = (file) => {
  const full = path.resolve(target, file);
  if (!full.startsWith(target + path.sep) || file.split("/").includes(".git")) throw new Error("Invalid export path");
  return full;
};
let initialized = fs.existsSync(path.join(target, ".git"));
if (fs.existsSync(target) && !initialized && fs.readdirSync(target).length) throw new Error("Target is not an empty directory or repository");
if (initialized && path.resolve(git(target, ["rev-parse", "--show-toplevel"]).trim()) !== target) throw new Error("Unexpected target repository");
const existing = initialized ? [...new Set(git(target, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))] : [];
const currentBytes = (file) => {
  const stat = fs.lstatSync(safe(file), { throwIfNoEntry: false });
  if (!stat) return null;
  return stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(safe(file))) : fs.readFileSync(safe(file));
};
const comparable = (bytes) => {
  if (!bytes || bytes.includes(0)) return bytes;
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? Buffer.from(text.replaceAll("\r\n", "\n")) : bytes;
};
const changed = [...contents].filter(([file, bytes]) => !comparable(currentBytes(file))?.equals(comparable(bytes))).map(([file]) => file);
const removed = existing.filter((file) => !contents.has(file));
console.log(JSON.stringify({ sourceRevision: ref ?? "index", upstreamBase: upstream, files: contents.size, changed, removed }, null, 2));
if (!write) process.exit(0);
if (initialized && git(target, ["status", "--porcelain"]).trim() && !args.includes("--allow-dirty")) {
  throw new Error("Target has uncommitted changes; review them or supply --allow-dirty with --backup=PATH");
}
if (args.includes("--allow-dirty")) {
  const backupArg = value("backup");
  if (!backupArg) throw new Error("Supply --backup=PATH when replacing uncommitted files");
  const backup = path.resolve(backupArg);
  if (fs.existsSync(backup) || backup === target || backup.startsWith(target + path.sep) || target.startsWith(backup + path.sep)) throw new Error("Choose a new backup directory outside the target");
  for (const file of existing) if (fs.existsSync(safe(file))) {
    const saved = path.resolve(backup, file);
    if (!saved.startsWith(backup + path.sep)) throw new Error("Invalid backup path");
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, currentBytes(file));
  }
}
if (!initialized) {
  fs.mkdirSync(target, { recursive: true });
  git(target, ["init", "--initial-branch=main"]);
  const pack = git(source, ["pack-objects", "--stdout", "--revs"], { input: upstream + "\n", encoding: null });
  git(target, ["index-pack", "--stdin"], { input: pack });
  git(target, ["-c", "core.symlinks=false", "checkout", "-B", "main", upstream]);
  git(target, ["config", "core.symlinks", "false"]);
  initialized = true;
}
for (const file of removed) fs.unlinkSync(safe(file));
for (const file of changed) {
  const bytes = contents.get(file);
  fs.mkdirSync(path.dirname(safe(file)), { recursive: true });
  const stat = fs.lstatSync(safe(file), { throwIfNoEntry: false });
  const record = exported.find((record) => record.file === file);
  if (stat?.isSymbolicLink()) fs.unlinkSync(safe(file));
  if (record.mode === "120000" && process.platform !== "win32") fs.symlinkSync(bytes.toString(), safe(file));
  else fs.writeFileSync(safe(file), bytes, { mode: record.mode === "100755" ? 0o755 : 0o644 });
}
console.log("Publication files updated. Review the diff before committing.");

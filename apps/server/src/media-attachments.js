import path from "node:path";

// Interpret protocol image fields, never arbitrary tool text as a file path.
export function mediaAttachments(item) {
  if (!item || typeof item !== "object") return [];
  const type = String(item.type || "").toLowerCase().replaceAll("_", "");
  const file = type === "imageview" ? item.path : type === "imagegeneration" ? (item.savedPath || item.saved_path) : null;
  const attachments = [];
  if (typeof file === "string" && path.isAbsolute(file)) attachments.push({ name: path.basename(file), path: file, kind: "image" });
  const content = item.result?.content || (Array.isArray(item.output) ? item.output : []);
  if (!Array.isArray(content)) return attachments;
  for (const [index, block] of content.entries()) {
    if (block?.type !== "image" || !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType || "")
        || typeof block.data !== "string" || block.data.length > 14 * 1024 * 1024
        || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(block.data)) continue;
    attachments.push({ name: `image-${index + 1}.${block.mimeType.split("/")[1]}`,
      path: `data:${block.mimeType};base64,${block.data}`, kind: "image" });
  }
  return attachments;
}

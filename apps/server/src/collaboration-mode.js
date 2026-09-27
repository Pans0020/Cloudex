export function collaborationModeParams(data, presets) {
  if (!data.collaborationMode) return {};
  const mode = data.collaborationMode;
  const preset = presets.find((value) => value.mode === mode);
  if (!["default", "plan"].includes(mode) || !preset) {
    throw Object.assign(new Error("This Codex host does not support the requested collaboration mode"), { status: 422 });
  }
  const model = data.model || preset.model;
  if (typeof model !== "string" || !model.trim()) {
    throw Object.assign(new Error("Select a model before using collaboration mode"), { status: 422 });
  }
  return { collaborationMode: { mode, settings: {
    model, reasoning_effort: data.effort || preset.reasoning_effort || null, developer_instructions: null,
  } } };
}

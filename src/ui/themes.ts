// Editor text-color presets. Themes change TEXT colors only — never backgrounds (the app's glass stays).
// All colors were checked for >= 3:1 contrast against the editor's glass (~#16151b).

export type TokenKey = "keyword" | "text" | "string" | "number" | "comment" | "punct" | "type";
export type TokenColors = Record<TokenKey, string>;

export interface Theme {
  id: string;
  name: string;
  tag: string;
  colors: TokenColors;
}

export const TOKEN_KEYS: { key: TokenKey; label: string }[] = [
  { key: "keyword", label: "Keywords" },
  { key: "text", label: "Identifiers" },
  { key: "string", label: "Strings" },
  { key: "number", label: "Numbers & dates" },
  { key: "comment", label: "Comments" },
  { key: "punct", label: "Operators" },
  { key: "type", label: "Functions & types" },
];

export const THEMES: Theme[] = [
  { id: "datatrip", name: "DataTrip Dark", tag: "Default", colors: { keyword: "#ff7088", text: "#ececf0", string: "#8fd9a8", number: "#ffc56b", comment: "#6e6e76", punct: "#a6a6ae", type: "#8fb4ff" } },
  { id: "darcula", name: "Darcula", tag: "DataGrip-like", colors: { keyword: "#cc7832", text: "#a9b7c6", string: "#6a8759", number: "#6897bb", comment: "#808080", punct: "#a9b7c6", type: "#ffc66d" } },
  { id: "onedark", name: "One Dark", tag: "", colors: { keyword: "#c678dd", text: "#abb2bf", string: "#98c379", number: "#d19a66", comment: "#7f848e", punct: "#abb2bf", type: "#61afef" } },
  { id: "github", name: "GitHub Dark", tag: "", colors: { keyword: "#ff7b72", text: "#e6edf3", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e", punct: "#e6edf3", type: "#d2a8ff" } },
  { id: "solar", name: "Solarized Dark", tag: "", colors: { keyword: "#859900", text: "#93a1a1", string: "#2aa198", number: "#d33682", comment: "#657b83", punct: "#93a1a1", type: "#268bd2" } },
  { id: "monokai", name: "Monokai", tag: "", colors: { keyword: "#f92672", text: "#f8f8f2", string: "#e6db74", number: "#ae81ff", comment: "#75715e", punct: "#f8f8f2", type: "#66d9ef" } },
  { id: "vscode", name: "VS Code Dark+", tag: "", colors: { keyword: "#569cd6", text: "#d4d4d4", string: "#ce9178", number: "#b5cea8", comment: "#6a9955", punct: "#d4d4d4", type: "#dcdcaa" } },
  { id: "dracula", name: "Dracula", tag: "", colors: { keyword: "#ff79c6", text: "#f8f8f2", string: "#f1fa8c", number: "#bd93f9", comment: "#6272a4", punct: "#f8f8f2", type: "#8be9fd" } },
  { id: "nord", name: "Nord", tag: "", colors: { keyword: "#81a1c1", text: "#d8dee9", string: "#a3be8c", number: "#b48ead", comment: "#7b88a1", punct: "#eceff4", type: "#88c0d0" } },
  { id: "gruvbox", name: "Gruvbox Dark", tag: "", colors: { keyword: "#fb4934", text: "#ebdbb2", string: "#b8bb26", number: "#d3869b", comment: "#928374", punct: "#ebdbb2", type: "#fabd2f" } },
  { id: "tokyo", name: "Tokyo Night", tag: "", colors: { keyword: "#bb9af7", text: "#c0caf5", string: "#9ece6a", number: "#ff9e64", comment: "#636da6", punct: "#89ddff", type: "#7aa2f7" } },
  { id: "catppuccin", name: "Catppuccin Mocha", tag: "", colors: { keyword: "#cba6f7", text: "#cdd6f4", string: "#a6e3a1", number: "#fab387", comment: "#7f849c", punct: "#94e2d5", type: "#89b4fa" } },
  { id: "nightowl", name: "Night Owl", tag: "", colors: { keyword: "#c792ea", text: "#d6deeb", string: "#ecc48d", number: "#f78c6c", comment: "#7a8c8c", punct: "#7fdbca", type: "#82aaff" } },
  { id: "palenight", name: "Material Palenight", tag: "", colors: { keyword: "#c792ea", text: "#a6accd", string: "#c3e88d", number: "#f78c6c", comment: "#7a80a8", punct: "#89ddff", type: "#82aaff" } },
  { id: "ayu", name: "Ayu Mirage", tag: "", colors: { keyword: "#ffad66", text: "#cccac2", string: "#d5ff80", number: "#dfbfff", comment: "#7a8494", punct: "#f29e74", type: "#ffd173" } },
  { id: "rosepine", name: "Rosé Pine", tag: "", colors: { keyword: "#3e8fb0", text: "#e0def4", string: "#f6c177", number: "#ebbcba", comment: "#7a7690", punct: "#908caa", type: "#9ccfd8" } },
  { id: "xcode", name: "Xcode Dark", tag: "", colors: { keyword: "#ff7ab2", text: "#dfdfe0", string: "#ff8170", number: "#d9c97c", comment: "#7f8c98", punct: "#dfdfe0", type: "#5dd8ff" } },
  { id: "synthwave", name: "SynthWave ’84", tag: "", colors: { keyword: "#fede5d", text: "#f0eff1", string: "#ff8b39", number: "#f97e72", comment: "#848bbd", punct: "#36f9f6", type: "#fede5d" } },
  { id: "cobalt", name: "Cobalt2", tag: "", colors: { keyword: "#ff9d00", text: "#ffffff", string: "#a5ff90", number: "#ff628c", comment: "#0088ff", punct: "#e1efff", type: "#ffc600" } },
  { id: "highcontrast", name: "High Contrast", tag: "", colors: { keyword: "#ff9d3b", text: "#ffffff", string: "#9fff8f", number: "#ffe066", comment: "#9ea7b0", punct: "#ffffff", type: "#4fc1ff" } },
];

export const DEFAULT_THEME = "datatrip";

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Swatches offered by the per-token color picker. */
export const TOKEN_PALETTE = ["#ff7088", "#ff9f0a", "#ffd60a", "#8fd9a8", "#40c8e0", "#8fb4ff", "#c99bff", "#ececf0", "#a6a6ae", "#6e6e76"];
